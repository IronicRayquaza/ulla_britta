import axios from 'axios';
import githubService from './github.service.mjs';

/**
 * Deployment Service
 * Handles the "Initiation" of hosting from scratch.
 */
class DeploymentService {
    constructor() {
        this.vercelToken = process.env.VERCEL_TOKEN;
    }

    /**
     * Detects if a repository is a candidate for web hosting.
     */
    async isDeployable(client, owner, repo) {
        try {
            const { data: tree } = await client.rest.git.getTree({ owner, repo, tree_sha: 'main', recursive: false });
            const files = tree.tree.map(f => f.path);
            
            return files.includes('package.json') || files.includes('index.html') || files.includes('next.config.js');
        } catch (e) {
            return false;
        }
    }

    /**
     * Deploys a repository to Vercel (Initial Setup).
     */
    async deployToVercel(repoFullName, installationId) {
        if (!this.vercelToken) {
            console.error('❌ Vercel Token missing in environment.');
            return null;
        }

        const [owner, repo] = repoFullName.split('/');
        
        try {
            console.log(`🚀 Initiating Vercel Setup for ${repoFullName}...`);
            
            // 1. Create the Project on Vercel
            const createResponse = await axios.post('https://api.vercel.com/v9/projects', {
                name: repo,
                framework: null, // Auto-detect
                gitRepository: {
                    type: 'github',
                    repo: repoFullName,
                }
            }, {
                headers: { Authorization: `Bearer ${this.vercelToken}` }
            });

            const projectId = createResponse.data.id;

            // 2. Trigger the First Deployment
            const deployResponse = await axios.post(`https://api.vercel.com/v13/deployments`, {
                name: repo,
                project: projectId,
                gitSource: {
                    type: 'github',
                    ref: 'main',
                    repoId: installationId // Use installation context
                }
            }, {
                headers: { Authorization: `Bearer ${this.vercelToken}` }
            });

            console.log(`✅ Vercel Project Created! URL: ${deployResponse.data.url}`);
            return deployResponse.data.url;
        } catch (error) {
            console.error('❌ Vercel Deployment Failed:', error.response?.data || error.message);
            return null;
        }
    }

    /**
     * Deploys to GitHub Pages (Initial Setup).
     */
    async deployToGitHubPages(installationId, repoFullName) {
        const [owner, repo] = repoFullName.split('/');
        const client = await githubService.getClient(installationId);

        try {
            console.log(`🚀 Enabling GitHub Pages for ${repoFullName}...`);
            await client.rest.repos.createPagesSite({
                owner,
                repo,
                source: {
                    branch: 'main',
                    path: '/'
                }
            });
            return `https://${owner}.github.io/${repo}/`;
        } catch (error) {
            console.error('❌ GitHub Pages Setup Failed:', error.message);
            return null;
        }
    }
}

export default new DeploymentService();
