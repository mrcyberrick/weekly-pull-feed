const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const directory = './thumbs';

fs.readdirSync(directory).forEach(file => {
  if (file.endsWith('.raw')) {
    const filePath = path.join(directory, file);
    const outputName = file.replace('.raw', '.webp');
    const outputPath = path.join(directory, outputName);

    sharp(filePath)
      .resize(300) // Standardized width
      .webp({ quality: 80 })
      .toFile(outputPath)
      .then(() => console.log(`Optimized: ${outputName}`))
      .catch(err => console.error(`Error processing ${file}:`, err));
  }
});
