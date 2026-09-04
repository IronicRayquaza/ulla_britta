import { GoogleGenerativeAI } from '@google/generative-ai';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

/**
 * Repo Creator Service
 * Conversational service to scaffold and push new repositories.
 */
class RepoCreatorService {
    constructor() {
        this.model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
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
}

export default new RepoCreatorService();
