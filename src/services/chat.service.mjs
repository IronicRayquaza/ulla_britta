import { GoogleGenerativeAI } from '@google/generative-ai';
import repoCreatorService from './repo-creator.service.mjs';
import databaseService from './database.service.mjs';
import githubService from './github.service.mjs';
import { sendEmail } from './email.service.mjs';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

/**
 * Integrated Chat Agent
 */
class ChatService {
    constructor() {
        this.tools = [
            {
                functionDeclarations: [
                    {
                        name: "get_sentinel_activity",
                        description: "Fetches recent autonomous fixes and failures from the Supabase memory.",
                        parameters: { type: "object", properties: {} }
                    },
                    {
                        name: "github_action",
                        description: "Performs a GitHub action like star, fork, or merge.",
                        parameters: {
                            type: "object",
                            properties: {
                                action: { type: "string", enum: ["star", "fork", "merge"] },
                                repoFullName: { type: "string" },
                                prNumber: { type: "number" }
                            },
                            required: ["action", "repoFullName"]
                        }
                    },
                    {
                        name: "create_repository",
                        description: "Scaffolds and creates a new repo.",
                        parameters: {
                            type: "object",
                            properties: {
                                prompt: { type: "string" },
                                techStack: { type: "string" }
                            },
                            required: ["prompt", "techStack"]
                        }
                    },
                    {
                        name: "send_note",
                        description: "Sends an email notification.",
                        parameters: {
                            type: "object",
                            properties: { message: { type: "string" } },
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

    async processMessage(userId, message) {
        try {
            const activity = await databaseService.getRecentActivity(userId, 5);
            const chat = this.model.startChat({
                history: [
                    {
                        role: "user",
                        parts: [{ text: `System Context: You are Ulla Britta. Recent Sentinel Activity: ${JSON.stringify(activity)}` }],
                    },
                    {
                        role: "model",
                        parts: [{ text: "Understood. I am Ulla Britta, ready to assist with DevOps and SRE tasks." }],
                    }
                ]
            });

            let result = await chat.sendMessage(message);
            let response = result.response;
            
            // Handle Tool Calls (Potential crash point fixed)
            const calls = response.functionCalls();
            
            if (calls && calls.length > 0) {
                const call = calls[0];
                const actionResult = await this.executeTool(userId, call.name, call.args);
                
                // Final response with tool results
                const finalResult = await chat.sendMessage([{
                    functionResponse: {
                        name: call.name,
                        response: { content: actionResult }
                    }
                }]);
                return finalResult.response.text();
            }

            return response.text();
        } catch (error) {
            console.error('🔥 Chat Processing Error:', error);
            throw error; // Rethrow for index.mjs to catch
        }
    }

    async executeTool(userId, name, args) {
        try {
            switch (name) {
                case 'get_sentinel_activity':
                    const activity = await databaseService.getRecentActivity(userId, 10);
                    return JSON.stringify(activity);
                
                case 'github_action':
                    const installationId = await databaseService.getInstallationIdByRepo(args.repoFullName, userId);
                    const client = await githubService.getClient(installationId);
                    const [owner, repo] = args.repoFullName.split('/');
                    
                    if (args.action === 'star') await githubService.starRepository(client, owner, repo);
                    if (args.action === 'fork') await githubService.forkRepository(client, owner, repo);
                    if (args.action === 'merge') await githubService.mergePullRequest(client, owner, repo, args.prNumber);
                    
                    return `Action ${args.action} on ${args.repoFullName} completed successfully.`;

                case 'create_repository':
                    this.executeRepoCreation(userId, args.prompt, args.techStack);
                    return "Scaffolding started. Email notification will follow.";

                case 'send_note':
                    await sendEmail({
                        to: 'satyam4698@gmail.com',
                        subject: '📩 Ulla Britta Note',
                        text: args.message
                    });
                    return "Email dispatched.";

                default:
                    return "Error: Unknown tool.";
            }
        } catch (e) {
            console.error(`❌ Tool execution failed (${name}):`, e);
            return `Error executing ${name}: ${e.message}`;
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
