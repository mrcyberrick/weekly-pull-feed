const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const directory = './thumbs';

// Ensure directory exists
if (!fs.existsSync(directory)) {
  console.log("Thumbs directory not found.");
  process.exit(0);
}

const files = fs.readdirSync(directory);
console.log(`Found ${files.length} total files in thumbs/`);

files.forEach(file => {
  if (file.endsWith('.raw')) {
    const inputPath = path.join(directory, file);
    const outputPath = path.join(directory, file.replace('.raw', '.webp'));

    sharp(inputPath)
      .resize(300) // FORCING RESIZE HERE
      .webp({ quality: 80 })
      .toFile(outputPath)
      .then(() => console.log(`Optimized: ${file} -> 300px wide`))
      .catch(err => console.error(`Error processing ${file}:`, err));
  }
});
