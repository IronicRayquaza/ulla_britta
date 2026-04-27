import { analyzeWithGemini } from './ai.service.mjs';

/**
 * Code Generator Service
 * Handles AI-driven planning and generation for new features.
 */
class CodeGenerator {
    /**
     * Generate a structured implementation plan.
     */
    async generatePlan(request, stack, structure) {
        const prompt = `
        You are Ulla Britta, an elite Software Architect.
        Feature Request: ${request.issue_title}
        Description: ${request.issue_body}

        Stack: ${JSON.stringify(stack)}
        Relevant Files: ${structure.slice(0, 5000)}

        Create an implementation plan. Return ONLY JSON:
        {
            "summary": "desc",
            "approach": "step-by-step",
            "filesToCreate": [{ "path": "path/file.js", "purpose": "why" }],
            "filesToModify": [{ "path": "path/file.js", "changes": "what" }],
            "confidence": 0-100
        }`;

        const raw = await analyzeWithGemini(prompt);
        return JSON.parse(raw.replace(/```json|```/g, '').trim());
    }

    /**
     * Generate content for a single file.
     */
    async generateFile(filePlan, stack, context = "") {
        const prompt = `
        Generating ${filePlan.path} for ${stack.framework} project.
        Purpose: ${filePlan.purpose}
        Context: ${context}
        
        Follow the existing repo style. Return ONLY CODE. No markdown unless it's in the code.`;
        
        const code = await analyzeWithGemini(prompt);
        return code.replace(/```javascript|```typescript|```jsx|```tsx|```/g, '').trim();
    }

    /**
     * Generate a test file.
     */
    async generateTest(filePath, originalCode) {
        const prompt = `Generate unit tests for this code using standard conventions:
        CODE:
        ${originalCode}
        
        Return ONLY the test code.`;
        
        const code = await analyzeWithGemini(prompt);
        return code.replace(/```javascript|```typescript|```/g, '').trim();
    }
}

export default new CodeGenerator();
