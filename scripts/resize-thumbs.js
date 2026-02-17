const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

const THUMBS_DIR = "thumbs";
const MAX_SIZE = 300;        // final pixel size
const QUALITY = 75;          // webp compression

async function optimizeImage(filePath) {
  try {
    const image = sharp(filePath);
    const metadata = await image.metadata();

    // Skip if already optimized
    if (
      metadata.format === "webp" &&
      metadata.width <= MAX_SIZE &&
      metadata.height <= MAX_SIZE
    ) {
      console.log("Already optimized:", filePath);
      return;
    }

    console.log("Optimizing:", filePath);

    const buffer = await image
      .resize(MAX_SIZE, MAX_SIZE, {
        fit: "inside",
        withoutEnlargement: true
      })
      .webp({ quality: QUALITY })
      .toBuffer();

    fs.writeFileSync(filePath, buffer);
  } catch (err) {
    console.log("Skipping file:", filePath, err.message);
  }
}

async function run() {
  if (!fs.existsSync(THUMBS_DIR)) {
    console.log("No thumbs folder found");
    return;
  }

  const files = fs.readdirSync(THUMBS_DIR);

  for (const file of files) {
    const fullPath = path.join(THUMBS_DIR, file);

    if (!fs.lstatSync(fullPath).isFile()) continue;

    await optimizeImage(fullPath);
  }

  console.log("Thumbnail optimization complete");
}

run();
