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
        this.model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
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
            const files = await repoCreatorService.scaffoldProject(prompt, techStack);
            const repoName = prompt.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 30);
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

    getHelpMessage() {
        return `🤖 **Ulla Britta Command Center Help**\n\n` +
               `- \`@ulla create [prompt]\`: Scaffold a new project\n` +
               `- \`@ulla status\`: Get system health report\n` +
               `- Or just ask me anything naturally! (e.g. "What failed today?")`;
    }

    async chatNaturally(userId, message) {
        const result = await this.model.generateContent(`You are Ulla Britta, a helpful AI DevOps assistant. User says: ${message}`);
        return result.response.text();
    }
}

export default new ChatService();
