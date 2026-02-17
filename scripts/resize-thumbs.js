const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const thumbsDir = path.join(__dirname, '..', 'thumbs');

(async () => {
  if (!fs.existsSync(thumbsDir)) {
    console.log("No thumbs directory found. Nothing to optimize.");
    return;
  }

  const files = fs.readdirSync(thumbsDir);

  for (const file of files) {
    // Only process image-like files
    if (!/\.(jpg|jpeg|png|webp)$/i.test(file)) {
      console.log("Skipping non-image file:", file);
      continue;
    }

    const fullPath = path.join(thumbsDir, file);

    try {
      console.log("Optimizing:", file);

      // Sharp auto-detects the real format even if extension is .webp
      await sharp(fullPath)
        .resize(300, 300, { fit: "inside" })
        .webp({ quality: 70 })
        .toFile(fullPath + ".tmp");

      // Replace original file
      fs.renameSync(fullPath + ".tmp", fullPath);

      console.log("Optimized:", file);

    } catch (err) {
      console.error("Skipping file due to error:", file);
      console.error(err.message);
      continue; // Prevents exit code 1
    }
  }

  console.log("Thumbnail optimization complete.");
})();
