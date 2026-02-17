const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const thumbsDir = path.join(__dirname, '..', 'thumbs');

(async () => {
  const files = fs.readdirSync(thumbsDir);

for (const file of files) {
  if (!file.endsWith('.raw')) continue;

  const inputPath = path.join(thumbsDir, file);
  const outputPath = inputPath.replace('.raw', '.webp');

  try {
    // Process and SAVE the new file
    await sharp(inputPath)
      .resize(300)
      .webp({ quality: 75 })
      .toFile(outputPath);
    
    console.log(`Successfully created: ${outputPath}`);
    
    // The YAML handles the 'git rm' of the .raw file, 
    // but you can also delete it here if preferred.
    fs.unlinkSync(inputPath); 
  } catch (err) {
    console.error("Sharp processing failed:", err);
  }
}
})();
