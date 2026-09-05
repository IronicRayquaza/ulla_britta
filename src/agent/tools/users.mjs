import { resolveClient, resolveInstallation, requireUserClient, preferUserClient } from '../github-access.mjs';
import { ok, fail, str, num, bool, enumOf, repoSummary, excerpt, collect, clampLimit } from './common.mjs';

/**
 * People and accounts.
 *
 * The agent used to say "my tools do not allow me to access user profile
 * information — I can only interact with repositories" when asked how many
 * followers the user had. That was true, and it should not have been: GitHub
 * exposes all of this, and an agent that runs someone's account should know who
 * they are.
 *
 * Reading public profile data works with the installation token. Acting as the
 * person — following, notifications, gists — needs their own token, and those
 * tools say so rather than failing quietly.
 */

const profile = (u) => ({
    login: u.login,
    name: u.name,
    type: u.type,
    bio: u.bio,
    company: u.company,
    location: u.location,
    blog: u.blog,
    email: u.email,
    followers: u.followers,
    following: u.following,
    publicRepos: u.public_repos,
    publicGists: u.public_gists,
    createdAt: u.created_at,
    url: u.html_url
});

export default [
    {
        name: 'get_user_profile',
        description: 'Reads a GitHub profile: follower and following counts, public repository count, bio, company, location and when the account was created. With no username it reads the user\'s own account. This is the tool for "how many followers do I have".',
        parameters: {
            type: 'object',
            properties: {
                username: str('GitHub username. Omit for the user\'s own account.')
            }
        },
        handler: async ({ username = null }, { userId }) => {
            const install = await resolveInstallation(userId);
            const target = username || install.login;
            const { client } = await resolveClient(userId);

            try {
                const { data } = await client.rest.users.getByUsername({ username: target });
                return ok({ ...profile(data), isYou: target.toLowerCase() === install.login.toLowerCase() });
            } catch (e) {
                if (e.status === 404) {
                    return fail('NOT_FOUND', `There is no GitHub account called "${target}".`);
                }
                throw e;
            }
        }
    },

    {
        name: 'list_followers',
        description: 'Lists the accounts following a user. With no username it lists the user\'s own followers.',
        parameters: {
            type: 'object',
            properties: {
                username: str('GitHub username. Omit for the user\'s own account.'),
                limit: num('How many to return (default 30)')
            }
        },
        handler: async ({ username = null, limit }, { userId }) => {
            const install = await resolveInstallation(userId);
            const target = username || install.login;
            const { client } = await resolveClient(userId);

            const [{ data: user }, followers] = await Promise.all([
                client.rest.users.getByUsername({ username: target }),
                collect(client, client.rest.users.listFollowersForUser, { username: target }, limit)
            ]);

            return ok({
                username: target,
                total: user.followers,
                count: followers.length,
                followers: followers.map(f => f.login)
            });
        }
    },

    {
        name: 'list_following',
        description: 'Lists the accounts a user follows. With no username it lists who the user themselves follows.',
        parameters: {
            type: 'object',
            properties: {
                username: str('GitHub username. Omit for the user\'s own account.'),
                limit: num('How many to return (default 30)')
            }
        },
        handler: async ({ username = null, limit }, { userId }) => {
            const install = await resolveInstallation(userId);
            const target = username || install.login;
            const { client } = await resolveClient(userId);

            const [{ data: user }, following] = await Promise.all([
                client.rest.users.getByUsername({ username: target }),
                collect(client, client.rest.users.listFollowingForUser, { username: target }, limit)
            ]);

            return ok({
                username: target,
                total: user.following,
                count: following.length,
                following: following.map(f => f.login)
            });
        }
    },

    {
        name: 'follow_user',
        sideEffecting: true,
        description: 'Follows a GitHub user as the user. Requires the user to have connected their GitHub account.',
        parameters: {
            type: 'object',
            properties: { username: str('GitHub username to follow') },
            required: ['username']
        },
        handler: async ({ username }, { userId }) => {
            const { client, login } = await requireUserClient(userId, 'Following someone');
            await client.rest.users.follow({ username });
            return ok({ followed: username, as: login });
        }
    },

    {
        name: 'unfollow_user',
        sideEffecting: true,
        description: 'Stops following a GitHub user.',
        parameters: {
            type: 'object',
            properties: { username: str('GitHub username to unfollow') },
            required: ['username']
        },
        handler: async ({ username }, { userId }) => {
            const { client, login } = await requireUserClient(userId, 'Unfollowing someone');
            await client.rest.users.unfollow({ username });
            return ok({ unfollowed: username, as: login });
        }
    },

    {
        name: 'list_public_repositories',
        description: 'Lists the public repositories belonging to any GitHub user or organization — including accounts the app is not installed on. Use this to look at someone else\'s work.',
        parameters: {
            type: 'object',
            properties: {
                username: str('GitHub username or organization'),
                sort: enumOf(['pushed', 'created', 'updated', 'full_name'], 'Ordering, default pushed'),
                limit: num('How many to return (default 30)')
            },
            required: ['username']
        },
        handler: async ({ username, sort = 'pushed', limit }, { userId }) => {
            const { client } = await resolveClient(userId);
            try {
                const repos = await collect(client, client.rest.repos.listForUser,
                    { username, sort, direction: 'desc' }, limit);
                return ok({
                    username,
                    count: repos.length,
                    repositories: repos.map(repoSummary)
                });
            } catch (e) {
                if (e.status === 404) return fail('NOT_FOUND', `There is no GitHub account called "${username}".`);
                throw e;
            }
        }
    },

    {
        name: 'list_starred_repositories',
        description: 'Lists the repositories a user has starred. With no username it lists the user\'s own stars.',
        parameters: {
            type: 'object',
            properties: {
                username: str('GitHub username. Omit for the user\'s own account.'),
                limit: num('How many to return (default 30)')
            }
        },
        handler: async ({ username = null, limit }, { userId }) => {
            const install = await resolveInstallation(userId);
            const target = username || install.login;
            const { client } = await resolveClient(userId);
            const starred = await collect(client, client.rest.activity.listReposStarredByUser,
                { username: target }, limit);
            return ok({
                username: target,
                count: starred.length,
                repositories: starred.map(r => ({ name: r.full_name, stars: r.stargazers_count, description: r.description }))
            });
        }
    },

    {
        name: 'list_organizations',
        description: 'Lists the organizations a user belongs to publicly. With no username it lists the user\'s own.',
        parameters: {
            type: 'object',
            properties: { username: str('GitHub username. Omit for the user\'s own account.') }
        },
        handler: async ({ username = null }, { userId }) => {
            const install = await resolveInstallation(userId);
            const target = username || install.login;
            const { client } = await resolveClient(userId);
            const orgs = await collect(client, client.rest.orgs.listForUser, { username: target }, 50);
            return ok({
                username: target,
                count: orgs.length,
                organizations: orgs.map(o => ({ login: o.login, description: o.description }))
            });
        }
    },

    {
        name: 'list_organization_members',
        description: 'Lists the public members of an organization.',
        parameters: {
            type: 'object',
            properties: { org: str('Organization login'), limit: num('How many to return') },
            required: ['org']
        },
        handler: async ({ org, limit }, { userId }) => {
            // Public membership is readable without an installation on that org, so
            // the client comes from the user rather than from the org named.
            const { client } = await resolveClient(userId);
            try {
                const members = await collect(client, client.rest.orgs.listMembers, { org }, limit);
                return ok({ organization: org, count: members.length, members: members.map(m => m.login) });
            } catch (e) {
                if (e.status === 404 || e.status === 403) {
                    return fail('NOT_VISIBLE', `I cannot list members of "${org}" — the app is not a member of it, or the membership is private.`);
                }
                throw e;
            }
        }
    },

    {
        name: 'search_users',
        description: 'Searches GitHub for people and organizations by name, location, language or follower count.',
        parameters: {
            type: 'object',
            properties: {
                query: str('Search terms, e.g. "rust location:berlin followers:>100"'),
                limit: num('How many to return (default 20)')
            },
            required: ['query']
        },
        handler: async ({ query, limit = 20 }, { userId }) => {
            const { client } = await resolveClient(userId);
            const { data } = await client.rest.search.users({ q: query, per_page: clampLimit(limit, 20) });
            return ok({
                query,
                total: data.total_count,
                count: data.items.length,
                users: data.items.map(u => ({ login: u.login, type: u.type, url: u.html_url }))
            });
        }
    },

    {
        name: 'list_notifications',
        description: 'Reads the user\'s GitHub notification inbox: mentions, review requests, and activity on things they subscribe to. Requires the user to have connected their GitHub account.',
        parameters: {
            type: 'object',
            properties: {
                all: bool('Include already-read notifications (default false)'),
                limit: num('How many to return (default 30)')
            }
        },
        handler: async ({ all = false, limit }, { userId }) => {
            const { client, login } = await requireUserClient(userId, 'Reading your notifications');
            const items = await collect(client, client.rest.activity.listNotificationsForAuthenticatedUser,
                { all }, limit);
            return ok({
                as: login,
                count: items.length,
                notifications: items.map(n => ({
                    reason: n.reason,
                    unread: n.unread,
                    repository: n.repository?.full_name,
                    title: n.subject?.title,
                    type: n.subject?.type,
                    updated_at: n.updated_at
                }))
            });
        }
    },

    {
        name: 'mark_notifications_read',
        sideEffecting: true,
        description: 'Marks the user\'s GitHub notifications as read, optionally only for one repository.',
        parameters: {
            type: 'object',
            properties: { repoName: str('Only this repository, "owner/repo". Omit for all.') }
        },
        handler: async ({ repoName = null }, { userId }) => {
            const { client, login } = await requireUserClient(userId, 'Marking notifications read');
            if (repoName) {
                const [owner, repo] = repoName.split('/');
                await client.rest.activity.markRepoNotificationsAsRead({ owner, repo });
                return ok({ as: login, markedRead: repoName });
            }
            await client.rest.activity.markNotificationsAsRead({});
            return ok({ as: login, markedRead: 'all' });
        }
    },

    {
        name: 'list_gists',
        description: 'Lists a user\'s public gists. With no username it lists the user\'s own, including private ones when they have connected their account.',
        parameters: {
            type: 'object',
            properties: {
                username: str('GitHub username. Omit for the user\'s own gists.'),
                limit: num('How many to return (default 20)')
            }
        },
        handler: async ({ username = null, limit = 20 }, { userId }) => {
            const install = await resolveInstallation(userId);
            const { client, asUser } = await preferUserClient(userId);

            const gists = (!username && asUser)
                ? await collect(client, client.rest.gists.list, {}, limit)
                : await collect(client, client.rest.gists.listForUser, { username: username || install.login }, limit);

            return ok({
                username: username || install.login,
                includesPrivate: !username && asUser,
                count: gists.length,
                gists: gists.map(g => ({
                    id: g.id,
                    description: g.description,
                    public: g.public,
                    files: Object.keys(g.files || {}),
                    updated_at: g.updated_at,
                    url: g.html_url
                }))
            });
        }
    },

    {
        name: 'create_gist',
        sideEffecting: true,
        description: 'Creates a gist owned by the user — a good way to share a snippet or a generated file without putting it in a repository. Requires the user to have connected their GitHub account.',
        parameters: {
            type: 'object',
            properties: {
                description: str('What the gist is'),
                filename: str('File name, e.g. notes.md'),
                content: str('File content'),
                public: bool('Make it public (default false)')
            },
            required: ['filename', 'content']
        },
        handler: async ({ description = '', filename, content, public: isPublic = false }, { userId }) => {
            const { client, login } = await requireUserClient(userId, 'Creating a gist');
            const { data } = await client.rest.gists.create({
                description,
                public: isPublic,
                files: { [filename]: { content } }
            });
            return ok({ as: login, id: data.id, url: data.html_url, public: data.public, files: [filename] });
        }
    }
];
