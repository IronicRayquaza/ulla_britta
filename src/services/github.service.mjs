import { Octokit } from 'octokit';
import { createAppAuth } from '@octokit/auth-app';
import crypto from 'crypto';

class GitHubService {
  async getClient(installationId) {
    if (!installationId) throw new Error("Missing Installation ID");
    return new Octokit({
      authStrategy: createAppAuth,
      auth: {
        appId: process.env.GITHUB_APP_ID,
        privateKey: process.env.GITHUB_PRIVATE_KEY.replace(/\\n/g, '\n'),
        installationId: installationId
      }
    });
  }

  /**
   * An Octokit authenticated as the App itself, not as an installation.
   *
   * Needed to ask GitHub about installations — including whether the one we have
   * recorded still exists. A reinstall issues a NEW installation id and silently
   * invalidates the old one, so a stored id can stop working with no warning and
   * no webhook we were listening for.
   */
  appClient() {
    if (!process.env.GITHUB_APP_ID || !process.env.GITHUB_PRIVATE_KEY) {
      throw new Error('GITHUB_APP_ID and GITHUB_PRIVATE_KEY are required to talk to GitHub as the App.');
    }
    return new Octokit({
      authStrategy: createAppAuth,
      auth: {
        appId: process.env.GITHUB_APP_ID,
        privateKey: process.env.GITHUB_PRIVATE_KEY.replace(/\\n/g, '\n')
      }
    });
  }

  /** Throws with status 404 when the installation no longer exists. */
  async getInstallation(installationId) {
    const { data } = await this.appClient().rest.apps.getInstallation({
      installation_id: Number(installationId)
    });
    return data;
  }

  /**
   * The App's current installation on an account, whatever its id is now.
   * This is what makes a stale id recoverable without asking the user to do
   * anything: the account is stable, the installation id is not.
   */
  async findInstallationForAccount(login) {
    const app = this.appClient();
    for (const lookup of [
      () => app.rest.apps.getUserInstallation({ username: login }),
      () => app.rest.apps.getOrgInstallation({ org: login })
    ]) {
      try {
        const { data } = await lookup();
        return data;
      } catch (e) {
        if (e.status !== 404) throw e;
      }
    }
    return null;
  }

  async getClientForOrg(orgName) {
    const appOctokit = new Octokit({
      authStrategy: createAppAuth,
      auth: {
        appId: process.env.GITHUB_APP_ID,
        privateKey: process.env.GITHUB_PRIVATE_KEY.replace(/\\n/g, '\n'),
      }
    });

    try {
      // Try as a GitHub Organization first
      const { data } = await appOctokit.rest.apps.getOrgInstallation({ org: orgName });
      return this.getClient(data.id);
    } catch (orgErr) {
      // Fallback: try as a personal GitHub account (user installation)
      try {
        const { data } = await appOctokit.rest.apps.getUserInstallation({ username: orgName });
        return this.getClient(data.id);
      } catch (userErr) {
        throw new Error(`GitHub App is not installed for "${orgName}". Install it at https://github.com/settings/installations`);
      }
    }
  }

  /**
   * Repository search.
   *
   * This claimed to "implement filters for trending" and had no notion of recency
   * at all — it sorted by all-time stars, so it answered "what is trending" with
   * the same handful of decade-old repositories every time, and the agent rightly
   * told users it could not do it.
   *
   * GitHub has no trending endpoint. The accepted approximation is stars gathered
   * on something recent, which is what createdAfter/pushedAfter express.
   */
  async searchRepositories(client, criteria) {
      const parts = [];
      if (criteria.topic) parts.push(`topic:${criteria.topic}`);
      if (criteria.keyword) parts.push(criteria.keyword);
      if (criteria.minStars) parts.push(`stars:>${criteria.minStars}`);
      if (criteria.language) parts.push(`language:${criteria.language}`);
      if (criteria.createdAfter) parts.push(`created:>${criteria.createdAfter}`);
      if (criteria.pushedAfter) parts.push(`pushed:>${criteria.pushedAfter}`);
      parts.push('archived:false'); // Only active repos

      // The search API rejects a query with no terms, and "everything, sorted by
      // stars" is a meaningful question — it just needs a floor to stand on.
      if (parts.length === 1) parts.unshift('stars:>1');

      const query = parts.join(' ');
      console.log(`🔍 Agent Searching GitHub: ${query}`);

      const { data } = await client.rest.search.repos({
          q: query,
          sort: criteria.sort || 'stars',
          order: 'desc',
          per_page: criteria.limit || 10
      });

      return {
          query,
          total: data.total_count,
          results: data.items.map(repo => ({
              full_name: repo.full_name,
              description: repo.description,
              stars: repo.stargazers_count,
              forks: repo.forks_count,
              language: repo.language,
              topics: repo.topics || [],
              created_at: repo.created_at,
              pushed_at: repo.pushed_at,
              url: repo.html_url
          }))
      };
  }

  /**
   * Creates a repository, in an organization or on a personal account.
   *
   * Two things were wrong here. The "already exists" branch called
   * `client.rest.apps.getAuthenticatedInstallation()`, which Octokit does not
   * define — so the recovery path threw "is not a function" and the user saw a
   * tool bug instead of their repository. And a personal-account creation was
   * attempted with an installation token, which GitHub refuses: POST /user/repos
   * is user-to-server only. The owner is now passed in by the caller, and the
   * personal-account path takes a client authenticated as the user.
   *
   * @param {object}  client   Installation client for an org, user client otherwise.
   * @param {object}  options
   * @param {string}  options.name
   * @param {string}  [options.owner]    Account the repository will belong to.
   * @param {boolean} [options.isOrg]    Create inside an organization.
   */
  async createRepository(client, {
    name,
    owner = null,
    description = '',
    isOrg = false,
    isPrivate = false,
    autoInit = true,
    gitignoreTemplate = null,
    licenseTemplate = null,
    homepage = null
  }) {
    const shared = {
      name,
      description: description || undefined,
      private: isPrivate,
      auto_init: autoInit,
      ...(gitignoreTemplate && { gitignore_template: gitignoreTemplate }),
      ...(licenseTemplate && { license_template: licenseTemplate }),
      ...(homepage && { homepage })
    };

    try {
      if (isOrg) {
        if (!owner) throw new Error('An organization name is required to create a repository in an org.');
        console.log(`🏗️ Creating repo "${name}" in org "${owner}"...`);
        const { data } = await client.rest.repos.createInOrg({ org: owner, ...shared });
        return data;
      }

      console.log(`🏗️ Creating repo "${name}" on personal account "${owner || 'authenticated user'}"...`);
      const { data } = await client.rest.repos.createForAuthenticatedUser(shared);
      return data;
    } catch (e) {
      // Already there: return the existing repository rather than failing, but only
      // when we can name the owner — never by asking GitHub who we are.
      const alreadyExists = /already exists/i.test(e.message || '');
      if (alreadyExists && owner) {
        const { data: repo } = await client.rest.repos.get({ owner, repo: name });
        return repo;
      }
      throw e;
    }
  }

  /**
   * Commits several files at once by building a tree.
   *
   * pushFile() commits one file per call, which means a five-file change lands as
   * five commits and can be observed half-applied. This writes them as a single
   * commit on top of the branch head.
   *
   * @param {Array<{path:string, content:string}>} files
   */
  async pushFiles(client, owner, repo, files, message, branch = null) {
    if (!files?.length) throw new Error('No files to commit.');

    const targetBranch = branch || (await client.rest.repos.get({ owner, repo })).data.default_branch;
    const { data: ref } = await client.rest.git.getRef({ owner, repo, ref: `heads/${targetBranch}` });
    const { data: baseCommit } = await client.rest.git.getCommit({
      owner, repo, commit_sha: ref.object.sha
    });

    const tree = await Promise.all(files.map(async (f) => {
      const { data: blob } = await client.rest.git.createBlob({
        owner, repo,
        content: Buffer.from(f.content).toString('base64'),
        encoding: 'base64'
      });
      return { path: f.path, mode: '100644', type: 'blob', sha: blob.sha };
    }));

    const { data: newTree } = await client.rest.git.createTree({
      owner, repo, base_tree: baseCommit.tree.sha, tree
    });

    const { data: commit } = await client.rest.git.createCommit({
      owner, repo, message, tree: newTree.sha, parents: [ref.object.sha]
    });

    await client.rest.git.updateRef({
      owner, repo, ref: `heads/${targetBranch}`, sha: commit.sha
    });

    return { sha: commit.sha, branch: targetBranch, files: files.map(f => f.path) };
  }

  async deleteFile(client, owner, repo, path, message, branch = null) {
    const { data } = await client.rest.repos.getContent({
      owner, repo, path, ...(branch && { ref: branch })
    });
    if (Array.isArray(data)) throw new Error(`"${path}" is a directory, not a file.`);

    await client.rest.repos.deleteFile({
      owner, repo, path, message, sha: data.sha, ...(branch && { branch })
    });
    return { path, deleted: true };
  }

  /** Directory listing, so the agent can explore a repository it has not seen. */
  async listDirectory(client, owner, repo, path = '', ref = null) {
    const { data } = await client.rest.repos.getContent({
      owner, repo, path, ...(ref && { ref })
    });
    if (!Array.isArray(data)) {
      return [{ name: data.name, path: data.path, type: 'file', size: data.size }];
    }
    return data.map(e => ({ name: e.name, path: e.path, type: e.type, size: e.size }));
  }

  async forkRepository(client, owner, repo) {
      const { data } = await client.rest.repos.createFork({ owner, repo });
      return data;
  }

  async starRepository(client, owner, repo) {
      await client.rest.activity.starRepoForAuthenticatedUser({ owner, repo });
      return true;
  }

   async listUserRepos(client) {
       // For GitHub Apps, the correct endpoint to list repos accessible to the installation
       // is listReposAccessibleToInstallation.
       const { data } = await client.rest.apps.listReposAccessibleToInstallation({
           per_page: 100
       });

       const repos = data.repositories || [];
       return repos.map(repo => ({
           full_name: repo.full_name,
           private: repo.private,
           fork: repo.fork,
           archived: repo.archived,
           default_branch: repo.default_branch,
           language: repo.language,
           stars: repo.stargazers_count,
           open_issues: repo.open_issues_count,
           updated_at: repo.updated_at,
           pushed_at: repo.pushed_at,
           description: repo.description
       }));
   }

  async deleteRepository(client, owner, repo) {
      await client.rest.repos.delete({ owner, repo });
      return true;
  }

  async mergePullRequest(client, owner, repo, pullNumber) {
      const { data } = await client.rest.pulls.merge({ owner, repo, pull_number: pullNumber });
      return data;
  }

  async pushFile(client, owner, repo, path, content, message) {
      const { data: fileData } = await client.rest.repos.getContent({ owner, repo, path }).catch(() => ({ data: null }));
      const sha = fileData ? fileData.sha : undefined;
      await client.rest.repos.createOrUpdateFileContents({
        owner, repo, path, message,
        content: Buffer.from(content).toString('base64'),
        sha
      });
  }

  async addComment(client, owner, repo, issueNumber, comment) {
      const { data } = await client.rest.issues.createComment({ owner, repo, issue_number: issueNumber, body: comment });
      return data;
  }

  async createBranch(client, owner, repo, branchName, baseBranch) {
      const { data: baseRef } = await client.rest.git.getRef({ owner, repo, ref: `heads/${baseBranch}` });
      await client.rest.git.createRef({ owner, repo, ref: `refs/heads/${branchName}`, sha: baseRef.object.sha });
  }

  async createOrUpdateFile(client, owner, repo, path, message, content, branch) {
      const { data: fileData } = await client.rest.repos.getContent({ owner, repo, path, ref: branch }).catch(() => ({ data: null }));
      const sha = fileData ? fileData.sha : undefined;
      await client.rest.repos.createOrUpdateFileContents({ owner, repo, path, message, content: Buffer.from(content).toString('base64'), sha, branch });
  }

  async createPullRequest(client, owner, repo, prData) {
      const { data } = await client.rest.pulls.create({ owner, repo, title: prData.title, body: prData.body, head: prData.head, base: prData.base });
      return data;
  }

  async getReadme(client, owner, repo) {
      try {
          const { data } = await client.rest.repos.getReadme({ owner, repo });
          return Buffer.from(data.content, 'base64').toString('utf8');
      } catch (e) {
          return "README not found.";
      }
  }

  /**
   * Verifies a GitHub webhook signature against the RAW request bytes.
   *
   * The caller must pass the untouched body. Re-serialising a parsed body does not
   * reliably reproduce what GitHub signed, so a valid delivery could be rejected
   * over key ordering or unicode escaping alone.
   */
  verifySignature(rawBody, signature) {
      if (!signature || !rawBody) return false;
      if (!process.env.GITHUB_WEBHOOK_SECRET) {
          console.error('❌ GITHUB_WEBHOOK_SECRET is not set; rejecting all webhooks.');
          return false;
      }

      const payload = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8');
      const digest = 'sha256=' + crypto
          .createHmac('sha256', process.env.GITHUB_WEBHOOK_SECRET)
          .update(payload)
          .digest('hex');

      const expected = Buffer.from(digest);
      const provided = Buffer.from(String(signature));
      // timingSafeEqual throws on a length mismatch, so check that first.
      if (expected.length !== provided.length) return false;

      try {
          return crypto.timingSafeEqual(expected, provided);
      } catch {
          return false;
      }
  }

  async getFileContent(client, owner, repo, path) {
      try {
           const { data } = await client.rest.repos.getContent({ owner, repo, path });
           if (Array.isArray(data)) return null; 
           if (data.content) {
               return Buffer.from(data.content, 'base64').toString('utf8');
           }
           return null;
       } catch (e) {
           return null;
       }
   }
}

export default new GitHubService();
