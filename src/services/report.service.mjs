/**
 * Ulla Britta Report Generator
 * Transforms structured AI analysis into professional markdown reports.
 */
export class UllaBrittaReportGenerator {
    constructor() {
        this.version = '1.0.0';
        this.docsUrl = 'https://docs.ullabritta.dev';
    }

    generate(data) {
        const sections = [];

        sections.push(this.generateHeader(data));
        sections.push(this.generateExecutiveSummary(data));
        sections.push(this.generateWhatChanged(data));
        sections.push(this.generateAIAnalysis(data));

        if (data.autoFixApplied) {
            sections.push(this.generateFixDetails(data));
        }

        sections.push(this.generateImpactAssessment(data));
        sections.push(this.generateQualityChecks(data));

        if ((data.warnings && data.warnings.length) || (data.suggestions && data.suggestions.length)) {
            sections.push(this.generateWarningsAndRecommendations(data));
        }

        sections.push(this.generateNextSteps(data));
        sections.push(this.generateResources(data));
        sections.push(this.generateFooter(data));

        return sections.join('\n\n---\n\n');
    }

    generateHeader(data) {
        return `# 🤖 Ulla Britta Analysis Report\n\n**Repository:** \`${data.owner}/${data.repo}\`  \n**Commit:** \`${(data.commitSha || '').substring(0, 8)}\`  \n**Branch:** ${data.branch}  \n**Author:** ${data.author}  \n**Analyzed:** ${new Date(data.timestamp).toLocaleString()}`;
    }

    generateExecutiveSummary(data) {
        const confidenceEmoji = this.getConfidenceEmoji(data.confidence);
        const impactEmoji = this.getImpactEmoji(data.impactLevel);

        return `## 📊 Executive Summary\n\n${data.summary}\n\n**Confidence Score:** ${confidenceEmoji} ${data.confidence}%  \n**Impact Level:** ${impactEmoji} ${data.impactLevel}  \n**Auto-Fix Applied:** ${data.autoFixApplied ? '✅ Yes' : '❌ No'}`;
    }

    generateWhatChanged(data) {
        let markdown = `## 🔍 What Changed\n\n### Files Modified (${data.filesChanged?.length || 0})\n\n| File | Changes | Type |\n|------|---------|------|\n`;

        data.filesChanged?.forEach(file => {
            markdown += `| \`${file.path}\` | +${file.additions} -${file.deletions} | ${file.language} |\n`;
        });

        if (data.keyChanges?.length) {
            markdown += '\n### Key Changes\n\n';
            data.keyChanges.forEach(change => {
                markdown += `- **${change.category}**: ${change.description}\n`;
            });
        }

        return markdown;
    }

    generateAIAnalysis(data) {
        let markdown = `## 🧠 AI Analysis\n\n### Root Cause\n\n${data.rootCause}\n\n**Error Type:** ${data.errorType}  \n**Location:** \`${data.errorLocation}\`\n`;

        if (data.originalCode && data.fixedCode) {
            const language = this.detectLanguage(data.errorLocation);
            markdown += `\n\`\`\`${language}\n// ❌ Before\n${data.originalCode}\n\n// ✅ After\n${data.fixedCode}\n\`\`\`\n`;
        }

        markdown += `\n### Why This Fix Works\n\n${data.whyItWorks}`;
        return markdown;
    }

    generateFixDetails(data) {
        let markdown = `## ⚡ Fix Details\n\n### Changes Applied\n\n${data.fixDescription || 'Fix was automatically applied based on AI analysis.'}\n`;
        
        if (data.diff) {
            markdown += `\n#### Modified Files\n\n\`\`\`diff\n${data.diff}\n\`\`\`\n`;
        }

        if (data.confidenceBreakdown) {
            markdown += `\n### Confidence Breakdown\n\n- **Syntax Correctness:** ${data.confidenceBreakdown.syntaxCorrectness}%\n- **Logic Validation:** ${data.confidenceBreakdown.logicValidation}%\n- **Best Practices:** ${data.confidenceBreakdown.bestPractices}%\n- **Test Coverage Impact:** ${data.confidenceBreakdown.testCoverageImpact}%`;
        }

        return markdown;
    }

    generateImpactAssessment(data) {
        return `## 🎯 Impact Assessment\n\n### Scope of Changes\n\n- **Lines Changed:** ${data.linesAdded || 0} added, ${data.linesRemoved || 0} removed\n- **Functions Affected:** ${data.functionsAffected || 0}\n- **Dependencies Modified:** ${data.dependenciesModified ? 'Yes' : 'No'}\n\n### Risk Analysis\n\n**Breaking Changes:** ${data.breakingChanges ? '⚠️ Yes' : '✅ No'}\n\n${data.breakingChanges ? data.breakingChangesDescription : 'No breaking changes identified.'}\n\n**Deployment Risk:** ${this.getImpactEmoji(data.deploymentRisk)} ${data.deploymentRisk}`;
    }

    generateQualityChecks(data) {
        return `## ✅ Quality Checks\n\n### Build Status\n\n- **Build Time:** ${data.buildTime || 'N/A'}\n- **Status:** ${data.buildStatus === 'Success' ? '✅' : '❌'} ${data.buildStatus}`;
    }

    generateWarningsAndRecommendations(data) {
        let markdown = `## 🚨 Warnings & Recommendations\n`;
        if (data.warnings?.length) {
            markdown += '\n### ⚠️ Potential Issues\n\n';
            data.warnings.forEach((warning, index) => {
                markdown += `${index + 1}. **${warning.title}** (${warning.severity})\n   - ${warning.description}\n   - **Recommendation:** ${warning.recommendation}\n\n`;
            });
        }
        if (data.suggestions?.length) {
            markdown += '### 💡 Suggestions\n\n' + data.suggestions.map(s => `- ${s}`).join('\n');
        }
        return markdown;
    }

    generateNextSteps(data) {
        let markdown = `## 📝 Next Steps\n`;
        data.immediateActions?.forEach(action => { markdown += `- [ ] ${action}\n`; });
        return markdown;
    }

    generateResources(data) {
        return `## 🔗 Resources\n\n- [View Full Diff on GitHub](${data.githubUrl})`;
    }

    generateFooter(data) {
        const statusEmoji = this.getStatusEmoji(data.status);
        return `## 📧 Report Generated By\n\n**Ulla Britta** v${this.version}  \nAutonomous GitHub Healing Agent\n\n**Status:** ${statusEmoji} \`${data.status}\``;
    }

    // Helpers
    getConfidenceEmoji(c) { return c >= 90 ? '🟢' : c >= 70 ? '🟡' : '🔴'; }
    getImpactEmoji(l) { return l === 'High' ? '🔴' : l === 'Medium' ? '🟡' : '🟢'; }
    getSeverityEmoji(s) { return this.getImpactEmoji(s); }
    getStatusEmoji(s) { 
        const map = { 'PROCEED': '✅', 'PROCEED WITH CAUTION': '⚠️', 'REQUIRES REVIEW': '🔍', 'DO NOT MERGE': '🛑' };
        return map[s] || '❓';
    }
    detectLanguage(filepath) {
        const ext = filepath?.split('.').pop()?.toLowerCase();
        const map = { 'ts': 'typescript', 'js': 'javascript', 'py': 'python', 'go': 'go' };
        return map[ext] || 'text';
    }
}

const generator = new UllaBrittaReportGenerator();
export function generateReport(data) { return generator.generate(data); }
