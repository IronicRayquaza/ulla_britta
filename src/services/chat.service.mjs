import { GoogleGenerativeAI } from '@google/generative-ai';
import repoCreatorService from './repo-creator.service.mjs';
import databaseService from './database.service.mjs';
import githubService from './github.service.mjs';
import { sendEmail } from './email.service.mjs';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

/**
 * Integrated Chat Agent
 * The "Prefrontal Cortex" of Ulla Britta.
 * Connects natural language to the Sentinel's memory and the GitHub App's hands.
 */
class ChatService {
    constructor() {
        // Define the Tool Chest for Gemini 3
        this.tools = [
            {
                functionDeclarations: [
                    {
                        name: "get_sentinel_activity",
                        description: "Fetches the latest autonomous fixes and failures from the Supabase memory.",
                        parameters: { type: "object", properties: {} }
                    },
                    {
                        name: "github_action",
                        description: "Performs a real GitHub action like star, fork, or merge.",
                        parameters: {
                            type: "object",
                            properties: {
                                action: { type: "string", enum: ["star", "fork", "merge"] },
                                repoFullName: { type: "string", description: "The owner/repo name" },
                                prNumber: { type: "number", description: "Only for merge action" }
                            },
                            required: ["action", "repoFullName"]
                        }
                    },
                    {
                        name: "create_repository",
                        description: "Scaffolds and creates a new repository based on a tech stack and prompt.",
                        parameters: {
                            type: "object",
                            properties: {
                                prompt: { type: "string", description: "What the repo is about" },
                                techStack: { type: "string", description: "e.g. Next.js, React, Node" }
                            },
                            required: ["prompt", "techStack"]
                        }
                    },
                    {
                        name: "send_note",
                        description: "Sends a quick email notification to the user.",
                        parameters: {
                            type: "object",
                            properties: {
                                message: { type: "string" }
                            },
                            required: ["message"]
                        }
                    }
                ]
            }
        ];

        this.model = genAI.getGenerativeModel({ 
            model: 'gemini-3-flash-preview',
            tools: this.tools
        });
    }

    /**
     * Processes a message using the Agentic Loop.
     */
    async processMessage(userId, message) {
        // 1. Load Live Context (The "Self-Awareness" Step)
        const activity = await databaseService.getRecentActivity(userId, 5);
        const context = `
            SYSTEM STATUS:
            - User ID: ${userId}
            - Recent Activity from Sentinel: ${JSON.stringify(activity)}
            
            You are Ulla Britta. Use the tools provided to act on GitHub or read your memory.
            Always confirm actions to the user.
        `;

        const chat = this.model.startChat();
        
        // 2. The Interaction Loop
        let result = await chat.sendMessage(message);
        let response = result.response;
        const call = response.functionCalls()?.[0];

        if (call) {
            // 3. The Execution Phase
            const actionResult = await this.executeTool(userId, call.name, call.args);
            
            // 4. Report back to Gemini so it can explain the result to the user
            const finalResult = await chat.sendMessage([{
                functionResponse: {
                    name: call.name,
                    response: { result: actionResult }
                }
            }]);
            return finalResult.response.text();
        }

        return response.text();
    }

    /**
     * Tool Executor
     */
    async executeTool(userId, name, args) {
        console.log(`🤖 Ulla executing tool: ${name}`, args);
        
        switch (name) {
            case 'get_sentinel_activity':
                return await databaseService.getRecentActivity(userId, 10);
            
            case 'github_action':
                const installationId = await databaseService.getInstallationIdByRepo(args.repoFullName, userId);
                const client = await githubService.getClient(installationId);
                const [owner, repo] = args.repoFullName.split('/');
                
                if (args.action === 'star') await githubService.starRepository(client, owner, repo);
                if (args.action === 'fork') await githubService.forkRepository(client, owner, repo);
                if (args.action === 'merge') await githubService.mergePullRequest(client, owner, repo, args.prNumber);
                
                return "Action successful.";

            case 'create_repository':
                // This triggers the scaffolding logic background
                this.executeRepoCreation(userId, args.prompt, args.techStack);
                return "Creation initiated. I will notify you via email when the repo is pushed.";

            case 'send_note':
                await sendEmail({
                    to: 'satyam4698@gmail.com',
                    subject: '📩 Ulla Britta Note',
                    text: args.message
                });
                return "Email sent.";

            default:
                return "Tool not found.";
        }
    }

    async executeRepoCreation(userId, prompt, techStack) {
        try {
            const repoName = prompt.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 20);
            const files = await repoCreatorService.scaffoldProject(prompt, techStack);
            await repoCreatorService.createAndPush(userId, repoName, prompt, files);
        } catch (error) {
            console.error('❌ Agent Background Repo Creation Failed:', error);
        }
    }
}

export default new ChatService();
