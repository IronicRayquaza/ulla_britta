import { GoogleGenerativeAI } from '@google/generative-ai';
import githubService from './github.service.mjs';
import databaseService from './database.service.mjs';
import { sendEmail } from './email.service.mjs';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

/**
 * Repo Creator Service
 * Conversational service to scaffold and push new repositories.
 */
class RepoCreatorService {
    constructor() {
        this.model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
    }

    /**
     * Scaffolds a project structure based on a prompt and tech stack.
     */
    async scaffoldProject(prompt, techStack) {
        const aiPrompt = `
            You are an expert software architect. Create a basic file structure and content for a new project.
            Project Idea: ${prompt}
            Tech Stack: ${techStack}

            Return a JSON object where keys are file paths and values are file contents.
            Include a README.md, package.json, and basic source files.
            
            Format:
            {
                "package.json": "{...}",
                "src/index.js": "...",
                "README.md": "..."
            }
        `;

        const result = await this.model.generateContent(aiPrompt);
        const text = result.response.text();
        
        // Clean the JSON output
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error("AI failed to generate valid project structure.");
        
        return JSON.parse(jsonMatch[0]);
    }

    /**
     * Creates and pushes a repository.
     */
    async createAndPush(userId, repoName, description, files) {
        // 1. Get GitHub Installation
        const installationId = await databaseService.getInstallationIdByRepo(repoName, userId);
        if (!installationId) throw new Error("GitHub App not installed for this user.");

        // 2. Create the Repo
        console.log(`🏗️ Creating repo: ${repoName}...`);
        const client = await githubService.getClient(installationId);
        await githubService.createRepository(client, repoName, description);
        
        // 3. Push files
        for (const [path, content] of Object.entries(files)) {
            await githubService.pushFile(
                'IronicRayquaza', // Owner
                repoName,
                path,
                content,
                'Initial commit by Ulla Britta Architect',
                installationId
            );
        }

        // 4. Send confirmation email
        await sendEmail({
            to: 'satyam4698@gmail.com',
            subject: `🚀 Repo Created: ${repoName}`,
            text: `Ulla Britta has successfully scaffolded and pushed your new project: ${repoName}.\n\nStack: ${description}`
        });

        return `https://github.com/IronicRayquaza/${repoName}`;
    }
}

export default new RepoCreatorService();
