import { App } from '@octokit/app';
import { Octokit } from '@octokit/rest';
import dotenv from 'dotenv';

dotenv.config();

/**
 * Service to handle GitHub App authentication and API interactions.
 */
class GitHubService {
  constructor() {
    this.appId = process.env.GITHUB_APP_ID;
    this.privateKey = process.env.GITHUB_PRIVATE_KEY?.replace(/\\n/g, '\n');
    this.secret = process.env.GITHUB_WEBHOOK_SECRET;

    if (this.appId && this.privateKey) {
        this.app = new App({
            appId: this.appId,
            privateKey: this.privateKey,
            webhooks: {
                secret: this.secret,
            },
        });
    }
  }

  /**
   * Returns an Octokit instance for a specific installation (repository/organization).
   */
  async getClient(installationId) {
    if (!this.app) {
        // Fallback to PAT for local testing if needed
        return new Octokit({ auth: process.env.GITHUB_TOKEN });
    }
    return await this.app.getInstallationOctokit(installationId);
  }

  /**
   * Verifies the webhook signature
   */
  verifySignature(payload, signature) {
    if (!this.secret || !signature) return true;
    return this.app.webhooks.verify(payload, signature);
  }
}

export default new GitHubService();
