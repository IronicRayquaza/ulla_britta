const { Resend } = require('resend');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config();

/**
 * Sends an email using Resend API.
 * This is "agentic-friendly" as it uses a professional delivery service.
 */
async function sendEmail(pdfPath, repoName) {
  const recipient = process.env.EMAIL_RECIPIENT || 'satyam4698@gmail.com';
  const apiKey = process.env.RESEND_API_KEY;

  if (!apiKey) {
    console.log('--- MOCK EMAIL (No Resend API Key) ---');
    console.log(`To: ${recipient}`);
    console.log(`Subject: [CodeNarrator] Analysis for ${repoName}`);
    console.log(`Attachment: ${pdfPath}`);
    console.log('Action Needed: Add RESEND_API_KEY to .env for real delivery.');
    console.log('------------------------------------');
    return;
  }

  const resend = new Resend(apiKey);
  const pdfBuffer = fs.readFileSync(pdfPath);

  try {
    const { data, error } = await resend.emails.send({
      from: 'CodeNarrator <onboarding@resend.dev>',
      to: [recipient],
      subject: `[CodeNarrator] New Analysis for ${repoName}`,
      text: `Your AI Agent has analyzed the latest changes in ${repoName}. Attached is the document summary.`,
      attachments: [
        {
          filename: `CodeNarrator-Report.pdf`,
          content: pdfBuffer,
        },
      ],
    });

    if (error) {
      return console.error('Resend Error:', error);
    }

    console.log('Email sent successfully via Resend! ID:', data.id);
  } catch (err) {
    console.error('Unexpected Error sending email:', err);
  }
}

module.exports = { sendEmail };
