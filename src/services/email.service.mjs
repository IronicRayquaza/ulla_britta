import { Resend } from 'resend';
import fs from 'fs';
import path from 'path';

export async function sendEmail(pdfPath, repoName) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn('RESEND_API_KEY not set. Skipping email.');
    return;
  }

  const resend = new Resend(apiKey);
  const pdfContent = fs.readFileSync(pdfPath);

  try {
    await resend.emails.send({
      from: 'CodeNarrator <onboarding@resend.dev>',
      to: process.env.EMAIL_RECIPIENT,
      subject: `[NARRATOR] New Activity in ${repoName}`,
      text: 'Project activity detected. See attached PDF report for AI-generated insights.',
      attachments: [{ filename: path.basename(pdfPath), content: pdfContent }]
    });
    console.log('✅ Email sent successfully!');
  } catch (error) {
    console.error('Failed to send email:', error.message);
  }
}
