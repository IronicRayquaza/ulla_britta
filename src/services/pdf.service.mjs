import PDFDocument from 'pdfkit';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function generatePDF(analysis) {
  return new Promise((resolve, reject) => {
    try {
      const reportsDir = path.join(__dirname, '../../reports');
      if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir);

      const fileName = `report_${Date.now()}.pdf`;
      const filePath = path.join(reportsDir, fileName);
      const doc = new PDFDocument();

      const stream = fs.createWriteStream(filePath);
      doc.pipe(stream);

      doc.fontSize(20).text('CodeNarrator: AI Commit Report', { align: 'center' });
      doc.moveDown();
      doc.fontSize(12).text(`Repository: ${analysis.repoName}`);
      doc.text(`Timestamp: ${analysis.timestamp}`);
      doc.text(`Commits Analyzed: ${analysis.commitCount}`);
      doc.moveDown();
      doc.fontSize(14).text('Analysis Insight:', { underline: true });
      doc.fontSize(11).text(analysis.summary);

      doc.end();

      stream.on('finish', () => resolve(filePath));
      stream.on('error', reject);
    } catch (e) {
      reject(e);
    }
  });
}
