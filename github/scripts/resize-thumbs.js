const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const thumbsDir = path.join(__dirname, '..', 'thumbs');

(async () => {
  const files = fs.readdirSync(thumbsDir);

  for (const file of files) {
    const fullPath = path.join(thumbsDir, file);

    // Skip non-images
    if (!/\.(jpg|jpeg|png|webp)$/i.test(file)) continue;

    console.log("Optimizing:", file);

    const outputPath = fullPath.replace(/\.(jpg|jpeg|png)$/i, '.webp');

    try {
      await sharp(fullPath)
        .resize({ width: 300 })     // max width 300px
        .webp({ quality: 80 })      // convert to WebP
        .toFile(outputPath);

      // Remove original file if extension changed
      if (outputPath !== fullPath) {
        fs.unlinkSync(fullPath);
      }

    } catch (err) {
      console.error("Failed to optimize:", file, err);
    }
  }
})();
