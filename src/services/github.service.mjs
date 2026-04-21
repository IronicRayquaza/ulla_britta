import { Octokit } from '@octokit/rest';
import { createAppAuth } from '@octokit/auth-app';
import dotenv from 'dotenv';

dotenv.config();

class GitHubService {
  constructor() {
    this.appId = process.env.GITHUB_APP_ID;
    this.privateKey = process.env.GITHUB_PRIVATE_KEY?.replace(/\\n/g, '\n');
  }

  /**
   * Returns a full-featured Octokit instance (REST + Actions + Apps).
   */
  async getClient(installationId) {
    if (this.appId && this.privateKey && installationId) {
        // High-Performance App Authentication
        return new Octokit({
            authStrategy: createAppAuth,
            auth: {
                appId: this.appId,
                privateKey: this.privateKey,
                installationId: installationId,
            },
        });
    } else {
        // Fallback to PAT for simple tasks
        return new Octokit({ auth: process.env.GITHUB_TOKEN });
    }
  }
}

export default new GitHubService();
