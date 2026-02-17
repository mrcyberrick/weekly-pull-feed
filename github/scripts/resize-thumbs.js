const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const thumbsDir = path.join(__dirname, '..', 'thumbs');

(async () => {
  const files = fs.readdirSync(thumbsDir);

  for (const file of files) {
    const fullPath = path.join(thumbsDir, file);

    // Only process image files
    if (!/\.(jpg|jpeg|png)$/i.test(file)) continue;

    console.log("Optimizing:", file);

    try {
      // Overwrite the original .jpg with WebP content
      await sharp(fullPath)
        .resize({ width: 300 })     // resize to max width 300px
        .webp({ quality: 80 })      // convert to WebP
        .toFile(fullPath);          // overwrite original file

      console.log("Optimized:", file);

    } catch (err) {
      console.error("Failed to optimize:", file, err);
    }
  }
})();
