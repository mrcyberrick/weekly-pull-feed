const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const THUMBS_DIR = './thumbs';
const TARGET_WIDTH = 300; // Set your desired thumbnail width

async function optimizeImages() {
  // Ensure the directory exists
  if (!fs.existsSync(THUMBS_DIR)) {
    console.log("Thumbs directory not found. Skipping.");
    return;
  }

  // Get all files in the thumbs directory
  const files = fs.readdirSync(THUMBS_DIR);
  
  // Filter for files with the .raw extension
  const rawFiles = files.filter(file => file.endsWith('.raw'));

  if (rawFiles.length === 0) {
    console.log("No .raw files found to process.");
    return;
  }

  console.log(`Found ${rawFiles.length} files to optimize...`);

  for (const file of rawFiles) {
    const inputPath = path.join(THUMBS_DIR, file);
    const fileName = path.parse(file).name; // Get name without .raw
    const outputPath = path.join(THUMBS_DIR, `${fileName}.webp`);

    try {
      console.log(`Processing: ${file}`);
      
      await sharp(inputPath)
        .resize(TARGET_WIDTH) // Resize to standard width
        .webp({ quality: 80 }) // Convert to WebP with 80% quality
        .toFile(outputPath);

      console.log(`Successfully created: ${fileName}.webp`);

      // Delete the .raw file after successful conversion
      fs.unlinkSync(inputPath);
      console.log(`Deleted original: ${file}`);
      
    } catch (err) {
      console.error(`Error processing ${file}:`, err);
    }
  }
}

optimizeImages().then(() => {
  console.log("Optimization workflow complete.");
}).catch(err => {
  console.error("Fatal error in optimization script:", err);
  process.exit(1);
});
