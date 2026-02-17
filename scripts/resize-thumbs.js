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
    if (!/\.(jpg|jpeg|png|webp)$/i.test(file)) {
      console.log("Skipping non-image file:", file);
      continue;
    }

    const fullPath = path.join(thumbsDir, file);

    try {
      const before = fs.statSync(fullPath).size;
      console.log(`Optimizing ${file} (before: ${before} bytes)`);

      // Force decode → resize → re-encode as WebP
      await sharp(fullPath, { failOn: 'none' })
        .rotate()
        .ensureAlpha()
        .resize(300, 300, { fit: "inside" })
        .webp({ quality: 70 })
        .toFile(fullPath + ".tmp");

      const after = fs.statSync(fullPath + ".tmp").size;

      // Validate output
      if (after < 500) {
        console.log(`Skipping corrupted output for ${file}`);
        fs.unlinkSync(fullPath + ".tmp");
        continue;
      }

      // Always overwrite original
      fs.renameSync(fullPath + ".tmp", fullPath);
      console.log(`Optimized ${file} → ${after} bytes`);

    } catch (err) {
      console.error("Skipping file due to error:", file);
      console.error(err.message);
      continue;
    }
  }

  console.log("Thumbnail optimization complete.");
})();
