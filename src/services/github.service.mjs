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
   * Advanced Search: The Agent's "Eyes".
   * Implements filters for trending, topic, and language.
   */
  async searchRepositories(client, criteria) {
      const parts = [];
      if (criteria.topic) parts.push(`topic:${criteria.topic}`);
      if (criteria.keyword) parts.push(criteria.keyword);
      if (criteria.minStars) parts.push(`stars:>${criteria.minStars}`);
      if (criteria.language) parts.push(`language:${criteria.language}`);
      parts.push('archived:false'); // Only active repos

      const query = parts.join(' ');
      console.log(`🔍 Agent Searching GitHub: ${query}`);

      const { data } = await client.rest.search.repos({
          q: query,
          sort: 'stars',
          order: 'desc',
          per_page: criteria.limit || 10
      });

      return data.items.map(repo => ({
          full_name: repo.full_name,
          description: repo.description,
          stars: repo.stargazers_count,
          forks: repo.forks_count,
          language: repo.language,
          topics: repo.topics || [],
          pushed_at: repo.pushed_at,
          url: repo.html_url
      }));
  }

  /**
   * CREATE: Targeted Organization/User Repo Creation.
   */
  async createRepository(client, name, description = '', orgName = null, isPrivate = false) {
    try {
      if (orgName) {
          console.log(`🏗️ Creating repo "${name}" in Org "${orgName}"...`);
          const { data } = await client.rest.repos.createInOrg({
            org: orgName,
            name,
            description,
            private: isPrivate,
            auto_init: true
          });
          return data;
      } else {
          console.log(`🏗️ Creating repo "${name}" in Personal Account...`);
          const { data } = await client.rest.repos.createForAuthenticatedUser({
            name,
            description,
            private: isPrivate,
            auto_init: true
          });
          return data;
      }
    } catch (e) {
      if (e.message.includes('already exists')) {
          const { data } = await client.rest.apps.getAuthenticatedInstallation();
          const { data: repo } = await client.rest.repos.get({ owner: data.account.login, repo: name });
          return repo;
      }
      throw e;
    }
  }

  async forkRepository(client, owner, repo) {
      const { data } = await client.rest.repos.createFork({ owner, repo });
      return data;
  }

  async starRepository(client, owner, repo) {
      await client.rest.activity.starRepoForAuthenticatedUser({ owner, repo });
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

  verifySignature(payloadString, signature) {
      if (!signature) return false;
      const hmac = crypto.createHmac('sha256', process.env.GITHUB_WEBHOOK_SECRET);
      const digest = 'sha256=' + hmac.update(payloadString).digest('hex');
      try {
          return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(signature));
      } catch (e) {
          return false;
      }
  }
}

export default new GitHubService();
