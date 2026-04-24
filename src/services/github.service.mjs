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
