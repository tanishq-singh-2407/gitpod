/**
 * Copyright (c) 2021 Gitpod GmbH. All rights reserved.
 * Licensed under the GNU Affero General Public License (AGPL).
 * See License.AGPL.txt in the project root for license information.
 */

import {
    Team,
    TeamMemberInfo,
    TeamMemberRole,
    TeamMembershipInvite,
    OrganizationSettings,
    User,
} from "@gitpod/gitpod-protocol";
import { inject, injectable } from "inversify";
import { TypeORM } from "./typeorm";
import { Repository } from "typeorm";
import { v4 as uuidv4 } from "uuid";
import { randomBytes } from "crypto";
import { TeamDB } from "../team-db";
import { DBTeam } from "./entity/db-team";
import { DBTeamMembership } from "./entity/db-team-membership";
import { DBUser } from "./entity/db-user";
import { DBTeamMembershipInvite } from "./entity/db-team-membership-invite";
import { ResponseError } from "vscode-jsonrpc";
import { ErrorCodes } from "@gitpod/gitpod-protocol/lib/messaging/error";
import slugify from "slugify";
import { DBOrgSettings } from "./entity/db-team-settings";

@injectable()
export class TeamDBImpl implements TeamDB {
    @inject(TypeORM) typeORM: TypeORM;

    protected async getEntityManager() {
        return (await this.typeORM.getConnection()).manager;
    }

    protected async getTeamRepo(): Promise<Repository<DBTeam>> {
        return (await this.getEntityManager()).getRepository<DBTeam>(DBTeam);
    }

    protected async getMembershipRepo(): Promise<Repository<DBTeamMembership>> {
        return (await this.getEntityManager()).getRepository<DBTeamMembership>(DBTeamMembership);
    }

    protected async getMembershipInviteRepo(): Promise<Repository<DBTeamMembershipInvite>> {
        return (await this.getEntityManager()).getRepository<DBTeamMembershipInvite>(DBTeamMembershipInvite);
    }

    protected async getOrgSettingsRepo(): Promise<Repository<DBOrgSettings>> {
        return (await this.getEntityManager()).getRepository<DBOrgSettings>(DBOrgSettings);
    }

    protected async getUserRepo(): Promise<Repository<DBUser>> {
        return (await this.getEntityManager()).getRepository<DBUser>(DBUser);
    }

    public async findTeams(
        offset: number,
        limit: number,
        orderBy: keyof Team,
        orderDir: "DESC" | "ASC",
        searchTerm?: string,
    ): Promise<{ total: number; rows: Team[] }> {
        const teamRepo = await this.getTeamRepo();
        const queryBuilder = teamRepo
            .createQueryBuilder("team")
            .where("LOWER(team.name) LIKE LOWER(:searchTerm)", { searchTerm: `%${searchTerm}%` })
            .skip(offset)
            .take(limit)
            .orderBy(orderBy, orderDir);

        const [rows, total] = await queryBuilder.getManyAndCount();
        return { total, rows };
    }

    public async findTeamById(teamId: string): Promise<Team | undefined> {
        const teamRepo = await this.getTeamRepo();
        return teamRepo.findOne({ id: teamId, deleted: false, markedDeleted: false });
    }

    public async findTeamByMembershipId(membershipId: string): Promise<Team | undefined> {
        const membershipRepo = await this.getMembershipRepo();
        const membership = await membershipRepo.findOne({ id: membershipId, deleted: false });
        if (!membership) {
            return;
        }
        return this.findTeamById(membership.teamId);
    }

    public async findMembersByTeam(teamId: string): Promise<TeamMemberInfo[]> {
        const membershipRepo = await this.getMembershipRepo();
        const userRepo = await this.getUserRepo();
        const memberships = await membershipRepo.find({ teamId, deleted: false });
        const users = await userRepo.findByIds(memberships.map((m) => m.userId));
        const infos = users.map((u) => {
            const m = memberships.find((m) => m.userId === u.id)!;
            return {
                userId: u.id,
                fullName: u.fullName || u.name,
                primaryEmail: User.getPrimaryEmail(u),
                avatarUrl: u.avatarUrl,
                role: m.role,
                memberSince: m.creationTime,
            };
        });
        return infos.sort((a, b) => (a.memberSince < b.memberSince ? 1 : a.memberSince === b.memberSince ? 0 : -1));
    }

    public async findTeamMembership(userId: string, teamId: string): Promise<DBTeamMembership | undefined> {
        const membershipRepo = await this.getMembershipRepo();
        return membershipRepo.findOne({ userId, teamId, deleted: false });
    }

    public async findTeamsByUser(userId: string): Promise<Team[]> {
        const teamRepo = await this.getTeamRepo();
        const membershipRepo = await this.getMembershipRepo();
        const memberships = await membershipRepo.find({ userId, deleted: false });
        const teams = await teamRepo.findByIds(memberships.map((m) => m.teamId));
        return teams.filter((t) => !t.markedDeleted);
    }

    public async findTeamsByUserAsSoleOwner(userId: string): Promise<Team[]> {
        // Find the memberships of this user,
        // and among the memberships, get the teams where the user is the sole owner
        const soleOwnedTeams = [];
        const userTeams = await this.findTeamsByUser(userId);
        for (const team of userTeams) {
            const memberships = await this.findMembersByTeam(team.id);
            const ownerships = memberships.filter((m) => m.role === "owner");
            if (ownerships.length === 1 && ownerships[0].userId === userId) {
                soleOwnedTeams.push(team);
            }
        }
        return soleOwnedTeams;
    }

    public async updateTeam(teamId: string, team: Pick<Team, "name" | "slug">): Promise<Team> {
        const name = team.name && team.name.trim();
        const slug = team.slug && team.slug.trim();
        if (!name && !slug) {
            throw new ResponseError(ErrorCodes.BAD_REQUEST, "No update provided");
        }

        // Storing entry in a TX to avoid potential slug dupes caused by racing requests.
        const em = await this.getEntityManager();
        return await em.transaction<DBTeam>(async (em) => {
            const teamRepo = em.getRepository<DBTeam>(DBTeam);

            const existingTeam = await teamRepo.findOne({ id: teamId, deleted: false, markedDeleted: false });
            if (!existingTeam) {
                throw new ResponseError(ErrorCodes.NOT_FOUND, "Organization not found");
            }

            // no changes
            if (existingTeam.name === name && existingTeam.slug === slug) {
                return existingTeam;
            }

            if (!!name) {
                if (name.length > 32) {
                    throw new ResponseError(
                        ErrorCodes.INVALID_VALUE,
                        "The name must be between 1 and 32 characters long",
                    );
                }
                existingTeam.name = name;
            }
            if (!!slug && existingTeam.slug != slug) {
                if (slug.length > 63) {
                    throw new ResponseError(ErrorCodes.INVALID_VALUE, "Slug must be between 1 and 63 characters long");
                }
                if (!/^[A-Za-z0-9-]+$/.test(slug)) {
                    throw new ResponseError(ErrorCodes.BAD_REQUEST, "Slug must contain only letters, or numbers");
                }
                const anotherTeamWithThatSlug = await teamRepo.findOne({ slug, deleted: false, markedDeleted: false });
                if (anotherTeamWithThatSlug) {
                    throw new ResponseError(ErrorCodes.INVALID_VALUE, "Slug must be unique");
                }
                existingTeam.slug = slug;
            }

            return teamRepo.save(existingTeam);
        });
    }

    public async createTeam(userId: string, name: string): Promise<Team> {
        if (!name) {
            throw new ResponseError(ErrorCodes.BAD_REQUEST, "Name cannot be empty");
        }
        name = name.trim();
        if (name.length < 3) {
            throw new ResponseError(
                ErrorCodes.BAD_REQUEST,
                "Please choose a name that is at least three characters long.",
            );
        }
        if (name.length > 64) {
            throw new ResponseError(ErrorCodes.BAD_REQUEST, "Please choose a name that is at most 64 characters long.");
        }

        let slug = slugify(name, { lower: true });

        if (slug.length < 3) {
            throw new ResponseError(
                ErrorCodes.BAD_REQUEST,
                "Please choose a name that is at least three characters long.",
            );
        }

        // Storing new entry in a TX to avoid potential dupes caused by racing requests.
        const em = await this.getEntityManager();
        const team = await em.transaction<DBTeam>(async (em) => {
            const teamRepo = em.getRepository<DBTeam>(DBTeam);

            const existingTeam = await teamRepo.findOne({ slug, deleted: false, markedDeleted: false });
            if (!!existingTeam) {
                slug = slug + "-" + randomBytes(4).toString("hex");
            }

            const team: Team = {
                id: uuidv4(),
                name,
                slug,
                creationTime: new Date().toISOString(),
            };
            return await teamRepo.save(team);
        });

        const membershipRepo = await this.getMembershipRepo();
        await membershipRepo.save({
            id: uuidv4(),
            teamId: team.id,
            userId,
            role: "owner",
            creationTime: team.creationTime,
        });
        return team;
    }

    public async deleteTeam(teamId: string): Promise<void> {
        const teamRepo = await this.getTeamRepo();
        const team = await this.findTeamById(teamId);
        if (team) {
            team.markedDeleted = true;
            await teamRepo.save(team);
            await this.deleteOrgSettings(teamId);
        }
    }

    private async deleteOrgSettings(orgId: string): Promise<void> {
        const orgSettingsRepo = await this.getOrgSettingsRepo();
        const orgSettings = await orgSettingsRepo.findOne({ where: { orgId, deleted: false } });
        if (orgSettings) {
            orgSettings.deleted = true;
            orgSettingsRepo.save(orgSettings);
        }
    }

    public async addMemberToTeam(userId: string, teamId: string): Promise<"added" | "already_member"> {
        const teamRepo = await this.getTeamRepo();
        const team = await teamRepo.findOne(teamId);
        if (!team || !!team.deleted) {
            throw new ResponseError(ErrorCodes.NOT_FOUND, "An organization with this ID could not be found");
        }
        const membershipRepo = await this.getMembershipRepo();
        const membership = await membershipRepo.findOne({ teamId, userId, deleted: false });
        if (!!membership) {
            // already a member, this is the desired outcome
            return "already_member";
        }
        await membershipRepo.save({
            id: uuidv4(),
            teamId: team.id,
            userId,
            role: "member",
            creationTime: new Date().toISOString(),
        });
        return "added";
    }

    public async setTeamMemberRole(userId: string, teamId: string, role: TeamMemberRole): Promise<void> {
        const teamRepo = await this.getTeamRepo();
        const team = await teamRepo.findOne(teamId);
        if (!team || !!team.deleted) {
            throw new ResponseError(ErrorCodes.NOT_FOUND, "An organization with this ID could not be found");
        }
        const membershipRepo = await this.getMembershipRepo();

        if (role != "owner") {
            const ownerCount = await membershipRepo.count({
                teamId,
                role: "owner",
                deleted: false,
            });
            if (ownerCount <= 1) {
                throw new ResponseError(ErrorCodes.CONFLICT, "An organization must retain at least one owner");
            }
        }

        const membership = await membershipRepo.findOne({ teamId, userId, deleted: false });
        if (!membership) {
            throw new ResponseError(ErrorCodes.NOT_FOUND, "The user is not currently a member of this organization");
        }
        membership.role = role;
        await membershipRepo.save(membership);
    }

    public async removeMemberFromTeam(userId: string, teamId: string): Promise<void> {
        const teamRepo = await this.getTeamRepo();
        const team = await teamRepo.findOne(teamId);
        if (!team || !!team.deleted) {
            throw new ResponseError(ErrorCodes.NOT_FOUND, "An organization with this ID could not be found");
        }
        const membershipRepo = await this.getMembershipRepo();
        const membership = await membershipRepo.findOne({ teamId, userId, deleted: false });
        if (!membership) {
            throw new ResponseError(
                ErrorCodes.BAD_REQUEST,
                "The given user is not currently a member of this organization or does not exist.",
            );
        }
        membership.deleted = true;
        await membershipRepo.save(membership);
    }

    public async findTeamMembershipInviteById(inviteId: string): Promise<TeamMembershipInvite> {
        const inviteRepo = await this.getMembershipInviteRepo();
        const invite = await inviteRepo.findOne(inviteId);
        if (!invite) {
            throw new ResponseError(ErrorCodes.NOT_FOUND, "No invite found for the given ID.");
        }
        return invite;
    }

    public async findGenericInviteByTeamId(teamId: string): Promise<TeamMembershipInvite | undefined> {
        const inviteRepo = await this.getMembershipInviteRepo();
        const all = await inviteRepo.find({ teamId });
        return all.filter((i) => i.invalidationTime === "" && !i.invitedEmail)[0];
    }

    public async resetGenericInvite(teamId: string): Promise<TeamMembershipInvite> {
        const inviteRepo = await this.getMembershipInviteRepo();
        const invite = await this.findGenericInviteByTeamId(teamId);
        if (invite && invite.invalidationTime === "") {
            invite.invalidationTime = new Date().toISOString();
            await inviteRepo.save(invite);
        }

        const newInvite: TeamMembershipInvite = {
            id: uuidv4(),
            creationTime: new Date().toISOString(),
            invalidationTime: "",
            role: "member",
            teamId,
        };
        await inviteRepo.save(newInvite);
        return newInvite;
    }

    public async findOrgSettings(orgId: string): Promise<OrganizationSettings | undefined> {
        const repo = await this.getOrgSettingsRepo();
        return repo.findOne({ where: { orgId, deleted: false }, select: ["orgId", "workspaceSharingDisabled"] });
    }

    public async setOrgSettings(orgId: string, settings: Partial<OrganizationSettings>): Promise<void> {
        const repo = await this.getOrgSettingsRepo();
        const team = await repo.findOne({ where: { orgId, deleted: false } });
        if (!team) {
            await repo.insert({
                ...settings,
                orgId,
            });
        } else {
            team.workspaceSharingDisabled = settings.workspaceSharingDisabled;
            repo.save(team);
        }
    }

    public async someOrgWithSSOExists(): Promise<boolean> {
        const repo = await this.getOrgSettingsRepo();
        const result = await repo.query(
            `select org.id from d_b_team as org inner join d_b_oidc_client_config as oidc on org.id = oidc.organizationId limit 1;`,
        );
        return result.length === 1;
    }
}
