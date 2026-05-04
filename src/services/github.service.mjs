import { Octokit } from '@octokit/rest';
import { createAppAuth } from '@octokit/auth-app';
import crypto from 'crypto';
import dotenv from 'dotenv';

dotenv.config();

class GitHubService {
  constructor() {
    this.appId = process.env.GITHUB_APP_ID;
    this.privateKey = process.env.GITHUB_PRIVATE_KEY?.replace(/\\n/g, '\n');
    this.webhookSecret = process.env.GITHUB_WEBHOOK_SECRET;
  }

  /**
   * Verifies the authenticity of incoming GitHub Webhooks.
   */
  verifySignature(payload, signature) {
    if (!this.webhookSecret || !signature) return false;

    const hmac = crypto.createHmac('sha256', this.webhookSecret);
    const digest = 'sha256=' + hmac.update(payload).digest('hex');

    try {
      return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(digest));
    } catch (e) {
      return false;
    }
  }

  /**
   * Helper to create a new branch from a base branch.
   */
  async createBranch(client, owner, repo, branchName, baseBranch = 'main') {
    try {
      const { data: ref } = await client.rest.git.getRef({ owner, repo, ref: `heads/${baseBranch}` });
      return await client.rest.git.createRef({ owner, repo, ref: `refs/heads/${branchName}`, sha: ref.object.sha });
    } catch (e) {
      if (e.message.includes('already exists')) return true; // Fail gracefully
      throw e;
    }
  }

  /**
   * Helper to create or update file content.
   */
  async createOrUpdateFile(client, owner, repo, path, message, content, branch, sha = null) {
    if (!sha) {
      try {
        const { data } = await client.rest.repos.getContent({ owner, repo, path, ref: branch });
        sha = data.sha;
      } catch (e) { sha = null; }
    }
    return await client.rest.repos.createOrUpdateFileContents({
      owner, repo, path, message, branch, sha,
      content: Buffer.from(content).toString('base64')
    });
  }

  /**
   * Helper to open a Pull Request.
   */
  async createPullRequest(client, owner, repo, { title, body, head, base }) {
    const { data: pr } = await client.rest.pulls.create({ owner, repo, title, body, head, base });
    return pr;
  }

  /**
   * Helper to add a comment to an issue or PR.
   */
  async addComment(client, owner, repo, issueNumber, body) {
    return await client.rest.issues.createComment({ owner, repo, issue_number: issueNumber, body });
  }

  /**
   * Creates a new repository on the user's account.
   */
  async createRepository(client, name, description = '', isPrivate = false) {
    try {
      const { data } = await client.rest.repos.createForAuthenticatedUser({
        name,
        description,
        private: isPrivate,
        auto_init: true
      });
      return data;
    } catch (e) {
      if (e.message.includes('already exists')) {
        // Get existing repo info
        const { data } = await client.rest.repos.get({
          owner: 'IronicRayquaza', // Fallback for testing
          repo: name
        });
        return data;
      }
      throw e;
    }
  }

  /**
   * Pushes a file directly to a branch (usually main for new repos).
   */
  async pushFile(owner, repo, path, content, message, installationId) {
    const client = await this.getClient(installationId);
    return await this.createOrUpdateFile(client, owner, repo, path, message, content, 'main');
  }

  /**
   * Forks a repository to the authenticated user's account.
   */
  async forkRepository(client, owner, repo) {
      const { data } = await client.rest.repos.createFork({ owner, repo });
      return data;
  }

  /**
   * Stars a repository.
   */
  async starRepository(client, owner, repo) {
      await client.rest.activity.starRepoForAuthenticatedUser({ owner, repo });
      return true;
  }

  /**
   * Merges a Pull Request.
   */
  async mergePullRequest(client, owner, repo, pullNumber) {
      const { data } = await client.rest.pulls.merge({ owner, repo, pull_number: pullNumber });
      return data;
  }

  /**
   * Returns a full-featured Octokit instance (REST + Actions + Apps).
   */
  async getClient(installationId) {
    if (this.appId && this.privateKey && installationId) {
      return new Octokit({
        authStrategy: createAppAuth,
        auth: {
          appId: this.appId,
          privateKey: this.privateKey,
          installationId: installationId,
        },
      });
    } else {
      return new Octokit({ auth: process.env.GITHUB_TOKEN });
    }
  }
}

export default new GitHubService();
