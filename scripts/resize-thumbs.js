const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const thumbsDir = path.join(__dirname, '..', 'thumbs');

(async () => {
  const files = fs.readdirSync(thumbsDir);

  for (const file of files) {
    // Only process the "raw" uploads from Google Apps Script
    if (!file.endsWith('.raw')) continue;

    const inputPath = path.join(thumbsDir, file);
    const outputPath = inputPath.replace('.raw', '.webp');

    console.log("Processing raw upload:", file);

    try {
      await sharp(inputPath)
        .resize(300) // Matches your THUMB_SIZE [cite: 1]
        .webp({ quality: 75, effort: 6 }) // High compression effort
        .toFile(outputPath);

      // Delete the uncompressed .raw file
      fs.unlinkSync(inputPath);
      console.log("Optimized to:", path.basename(outputPath));

    } catch (err) {
      console.error("Failed to optimize:", file, err);
    }
  }
})();
