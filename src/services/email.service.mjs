import nodemailer from 'nodemailer';
import dotenv from 'dotenv';
import fs from 'fs';

dotenv.config();

/**
 * Sends an email report.
 * @param {string} content - Can be a file path (to PDF) or raw Markdown string.
 * @param {string} repository - Repository name for the subject line.
 */
export async function sendEmail(content, repository) {
    const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_PASS,
        },
    });

    // Determine if content is a file path or raw text
    const isFilePath = content.length < 500 && fs.existsSync(content);
    
    const mailOptions = {
        from: process.env.EMAIL_USER,
        to: process.env.ALERT_EMAIL || process.env.EMAIL_USER,
        subject: `🤖 Ulla Britta: Analysis for ${repository}`,
    };

    if (isFilePath) {
        mailOptions.text = `Please find the analysis report attached for ${repository}.`;
        mailOptions.attachments = [{ filename: 'analysis_report.pdf', path: content }];
    } else {
        // It's the new High-Fidelity Markdown report
        mailOptions.text = content;
        // Optionally wrap in HTML if your transporter supports it
        mailOptions.html = `<div style="font-family: sans-serif; color: #333;">
            <pre style="white-space: pre-wrap; font-family: inherit;">${content}</pre>
        </div>`;
    }

    try {
        await transporter.sendMail(mailOptions);
        console.log('✅ Email sent successfully!');
        
        // Cleanup if it was a temp file
        if (isFilePath && content.includes('tmp')) {
            fs.unlinkSync(content);
        }
    } catch (error) {
        console.error('❌ Email failed:', error.message);
        throw error;
    }
}
