import { GoogleGenerativeAI } from '@google/generative-ai';
import repoCreatorService from './repo-creator.service.mjs';
import databaseService from './database.service.mjs';
import vercelService from './vercel.service.mjs';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

/**
 * Chat Service
 * Handles conversational state and command routing.
 */
class ChatService {
    constructor() {
        this.model = genAI.getGenerativeModel({ model: 'gemini-3-flash-preview' });
        this.sessions = new Map(); // Store conversational state for repo creation
    }

    /**
     * Processes an incoming message and returns a response.
     */
    async processMessage(userId, message) {
        const lower = message.toLowerCase().trim();

        // 1. Handle Active Creation Sessions
        if (this.sessions.has(userId)) {
            return await this.continueRepoCreation(userId, message);
        }

        // 2. Handle Commands
        if (lower.startsWith('@ulla ')) {
            const parts = lower.slice(6).trim().split(' ');
            const command = parts[0];
            const args = parts.slice(1);

            switch (command) {
                case 'create':
                    return await this.startRepoCreation(userId, args.join(' '));
                case 'summarize':
                    return await this.getRepoSummary(userId, args[0]);
                case 'fork':
                    return await this.handleGitHubAction(userId, 'fork', args[0]);
                case 'star':
                    return await this.handleGitHubAction(userId, 'star', args[0]);
                case 'merge':
                    return await this.handleGitHubAction(userId, 'merge', args[0], args[1]);
                case 'email':
                    return await this.sendQuickEmail(userId, args.join(' '));
                case 'status':
                    return await this.getSystemStatus(userId);
                case 'help':
                    return this.getHelpMessage();
                default:
                    return `🤖 I'm not sure how to do \`${command}\` yet. Type \`@ulla help\` for a list of skills.`;
            }
        }

        // 3. Natural Language (Gemini fallback)
        return await this.chatNaturally(userId, message);
    }

    async startRepoCreation(userId, prompt) {
        if (!prompt) return "🤖 What kind of repo should I create? (e.g., '@ulla create a music platform')";
        
        this.sessions.set(userId, { 
            step: 'tech_stack', 
            prompt,
            data: {} 
        });

        return `🏗️ **Architecting Mode Active**\n\nSounds like a great project! What **tech stack** should I use? (e.g., Next.js, Vite/React, or Node.js)`;
    }

    async continueRepoCreation(userId, message) {
        const session = this.sessions.get(userId);

        if (session.step === 'tech_stack') {
            session.data.techStack = message;
            session.step = 'confirm';
            return `✅ Got it. I'll scaffold a **${message}** project for **"${session.prompt}"**.\n\nShould I go ahead and push this to your GitHub? (Yes/No)`;
        }

        if (session.step === 'confirm' && message.toLowerCase().includes('yes')) {
            this.sessions.delete(userId); // Clear session
            
            // Background Scaffolding
            this.executeRepoCreation(userId, session.prompt, session.data.techStack);

            return `🚀 **Deployment Initiated!**\n\nI'm scaffolding the code and pushing it to your GitHub now. I'll send you an email once it's live!`;
        }

        this.sessions.delete(userId);
        return "🛑 Creation cancelled. Let me know if you need anything else!";
    }

    async executeRepoCreation(userId, prompt, techStack) {
        try {
            // Clean naming: "Create a music app" -> "music-app"
            const repoName = prompt
                .toLowerCase()
                .replace(/create|a|new|repo|for|my/g, '') // Remove fluff
                .trim()
                .replace(/[^a-z0-9]/g, '-') // Replace symbols
                .replace(/-+/g, '-') // Remove double dashes
                .slice(0, 20); // Keep it short
                
            const files = await repoCreatorService.scaffoldProject(prompt, techStack);
            await repoCreatorService.createAndPush(userId, repoName, prompt, files);
            console.log(`✅ Project ${repoName} created successfully.`);
        } catch (error) {
            console.error('❌ Failed to create repo:', error);
        }
    }

    async getSystemStatus(userId) {
        const integrations = await databaseService.getAllVercelIntegrations();
        const activeCount = integrations.length;
        
        return `📊 **Ulla Britta Health Report**\n\n` +
               `- **Vercel Sentinel**: 🟢 Online\n` +
               `- **Active Integrations**: ${activeCount}\n` +
               `- **Worker Tier**: 🦾 Active\n\n` +
               `I am currently monitoring your deployments for failures.`;
    }

    async getRepoSummary(userId, repoFullName) {
        if (!repoFullName) return "🤖 Please specify a repo: `@ulla summarize owner/repo`";

        try {
            const installationId = await databaseService.getInstallationIdByRepo(repoFullName, userId);
            if (!installationId) return `❌ I couldn't find a GitHub installation for \`${repoFullName}\`.`;

            const client = await githubService.getClient(installationId);
            const [owner, repo] = repoFullName.split('/');
            
            // Get last 5 commits
            const { data: commits } = await client.rest.repos.listCommits({ owner, repo, per_page: 5 });
            
            const commitHistory = commits.map(c => `- ${c.commit.message} (by ${c.commit.author.name})`).join('\n');

            const aiPrompt = `
                Summarize the following recent activity for the repository "${repoFullName}":
                
                COMMITS:
                ${commitHistory}
                
                Provide a concise, professional summary of what has been changed and any detected patterns in the work.
            `;

            const result = await this.model.generateContent(aiPrompt);
            return `## 📊 Repository Summary: \`${repoFullName}\`\n\n${result.response.text()}`;

        } catch (error) {
            console.error('Summary Error:', error);
            return `❌ Failed to summarize repo: ${error.message}`;
        }
    }

    async handleGitHubAction(userId, action, repoFullName, extraArg) {
        if (!repoFullName) return `🤖 Please specify a repo: \`@ulla ${action} owner/repo\``;

        try {
            const installationId = await databaseService.getInstallationIdByRepo(repoFullName, userId);
            if (!installationId) return `❌ GitHub installation not found for \`${repoFullName}\`.`;

            const client = await githubService.getClient(installationId);
            const [owner, repo] = repoFullName.split('/');

            if (action === 'fork') {
                const data = await githubService.forkRepository(client, owner, repo);
                return `🍴 **Forked!** You can find it here: ${data.html_url}`;
            } else if (action === 'star') {
                await githubService.starRepository(client, owner, repo);
                return `⭐ **Starred!** Showed some love to \`${repoFullName}\`.`;
            } else if (action === 'merge') {
                if (!extraArg) return "🤖 Please specify a PR number: `@ulla merge owner/repo 123`";
                await githubService.mergePullRequest(client, owner, repo, parseInt(extraArg));
                return `✅ **Merged!** Pull Request #${extraArg} in \`${repoFullName}\` is now closed.`;
            }
        } catch (error) {
            return `❌ GitHub Action Failed: ${error.message}`;
        }
    }

    async sendQuickEmail(userId, message) {
        if (!message) return "🤖 What should I say in the email?";
        try {
            await sendEmail({
                to: 'satyam4698@gmail.com',
                subject: '📩 Ulla Britta Quick Note',
                text: `Message from your dashboard:\n\n${message}`
            });
            return "✉️ **Email sent!** Check your inbox.";
        } catch (error) {
            return `❌ Email Failed: ${error.message}`;
        }
    }

    getHelpMessage() {
        return `🤖 **Ulla Britta Command Center Help**\n\n` +
               `- \`@ulla create [prompt]\`: Scaffold a new project\n` +
               `- \`@ulla status\`: Get system health report\n` +
               `- Or just ask me anything naturally! (e.g. "What failed today?")`;
    }

    async chatNaturally(userId, message) {
        const systemPrompt = `
            You are Ulla Britta, a high-performance Autonomous AI SRE and DevOps Architect.
            
            YOUR IDENTITY:
            - You are connected to the user's GitHub account via a GitHub App.
            - You are connected to the user's Vercel account.
            - You have the power to create repos, summarize commits, and fix build failures.
            
            YOUR CAPABILITIES:
            - If a user asks to summarize a repo, tell them: "I can do that! Please tell me the repo name (e.g. owner/repo)."
            - If they ask about failures, check the Vercel status.
            - You are helpful, slightly tech-noir, and very efficient.
            
            Current User Message: ${message}
        `;

        const result = await this.model.generateContent(systemPrompt);
        return result.response.text();
    }
}

export default new ChatService();
