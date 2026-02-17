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
      const tempPath = fullPath + ".tmp";

      // Write optimized WebP to a temporary file
      await sharp(fullPath)
        .resize({ width: 300 })
        .webp({ quality: 80 })
        .toFile(tempPath);

      // Replace original file with optimized version
      fs.renameSync(tempPath, fullPath);

      console.log("Optimized:", file);

    } catch (err) {
      console.error("Failed to optimize:", file, err);
    }
  }
})();
