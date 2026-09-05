import { clientForRepo } from '../github-access.mjs';
import { ok, fail, str, num, bool, REPO, excerpt, collect } from './common.mjs';

/**
 * Releases and tags — how a repository publishes a version.
 */
export default [
    {
        name: 'list_releases',
        description: 'Lists a repository\'s releases, newest first, with their tags and publication dates.',
        parameters: {
            type: 'object',
            properties: { repoName: REPO, limit: num('How many to return (default 10)') },
            required: ['repoName']
        },
        handler: async ({ repoName, limit = 10 }, { userId }) => {
            const { client, owner, repo } = await clientForRepo(userId, repoName);
            const releases = await collect(client, client.rest.repos.listReleases, { owner, repo }, limit);
            return ok({
                repository: `${owner}/${repo}`,
                count: releases.length,
                releases: releases.map(r => ({
                    tag: r.tag_name,
                    name: r.name,
                    draft: r.draft,
                    prerelease: r.prerelease,
                    published_at: r.published_at,
                    url: r.html_url
                }))
            });
        }
    },

    {
        name: 'get_latest_release',
        description: 'Reads the most recent published release, including its release notes. Use this to answer "what version is it on" or "what changed in the last release".',
        parameters: {
            type: 'object',
            properties: { repoName: REPO },
            required: ['repoName']
        },
        handler: async ({ repoName }, { userId }) => {
            const { client, owner, repo } = await clientForRepo(userId, repoName);
            try {
                const { data } = await client.rest.repos.getLatestRelease({ owner, repo });
                return ok({
                    repository: `${owner}/${repo}`,
                    tag: data.tag_name,
                    name: data.name,
                    published_at: data.published_at,
                    notes: excerpt(data.body || '', 6000),
                    url: data.html_url
                });
            } catch (e) {
                if (e.status === 404) {
                    return fail('NOT_FOUND', `${owner}/${repo} has no published releases.`);
                }
                throw e;
            }
        }
    },

    {
        name: 'create_release',
        sideEffecting: true,
        description: 'Publishes a release against a tag, creating the tag if it does not exist. Can generate the release notes from the commits since the previous release.',
        parameters: {
            type: 'object',
            properties: {
                repoName: REPO,
                tag: str('Tag name, e.g. v1.2.0'),
                name: str('Release title. Defaults to the tag.'),
                body: str('Release notes, in Markdown'),
                target: str('Branch or SHA to tag. Defaults to the default branch.'),
                draft: bool('Create as a draft (default false)'),
                prerelease: bool('Mark as a pre-release (default false)'),
                generateNotes: bool('Let GitHub write the notes from the commits (default false)')
            },
            required: ['repoName', 'tag']
        },
        handler: async (args, { userId, logger }) => {
            const { repoName, tag, name, body = '', target, draft = false, prerelease = false, generateNotes = false } = args;
            const { client, owner, repo } = await clientForRepo(userId, repoName);

            try {
                const { data } = await client.rest.repos.createRelease({
                    owner, repo,
                    tag_name: tag,
                    name: name || tag,
                    body,
                    draft,
                    prerelease,
                    generate_release_notes: generateNotes,
                    ...(target && { target_commitish: target })
                });
                await logger?.info(`Published release ${tag} on ${owner}/${repo}`);
                return ok({
                    repository: `${owner}/${repo}`,
                    tag: data.tag_name,
                    name: data.name,
                    draft: data.draft,
                    prerelease: data.prerelease,
                    url: data.html_url,
                    notes: excerpt(data.body || '', 2000)
                });
            } catch (e) {
                if (e.status === 422) {
                    return fail('CANNOT_RELEASE', `GitHub refused that release: ${e.message}`, {
                        hint: `A release for the tag "${tag}" may already exist, or the target ref does not.`
                    });
                }
                throw e;
            }
        }
    }
];
