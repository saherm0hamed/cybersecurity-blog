const cloudinary = require('cloudinary').v2;
const { Readable } = require('stream');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

/**
 * Upload a buffer to Cloudinary and return the secure URL and public_id.
 * @param {Buffer} buffer  - file buffer from multer memoryStorage
 * @param {string} folder  - Cloudinary folder e.g. 'blog/posts/123'
 * @returns {Promise<{ url: string, public_id: string }>}
 */
function uploadToCloudinary(buffer, folder) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder,
        resource_type: 'image',
        transformation: [{ quality: 'auto', fetch_format: 'auto' }]
      },
      (error, result) => {
        if (error) return reject(error);
        resolve({ url: result.secure_url, public_id: result.public_id });
      }
    );
    Readable.from(buffer).pipe(stream);
  });
}

/**
 * Delete an image from Cloudinary by its public_id.
 * Safely extracts public_id from a Cloudinary URL if needed.
 * @param {string} publicIdOrUrl
 */
async function deleteFromCloudinary(publicIdOrUrl) {
  if (!publicIdOrUrl) return;
  try {
    // If a full URL is passed, extract the public_id from it
    let publicId = publicIdOrUrl;
    if (publicIdOrUrl.startsWith('http')) {
      // e.g. https://res.cloudinary.com/<cloud>/image/upload/v123/blog/posts/1/abc.webp
      const matches = publicIdOrUrl.match(/\/upload\/(?:v\d+\/)?(.+)\.[a-z]+$/i);
      if (matches) publicId = matches[1];
      else return; // can't parse, skip
    }
    await cloudinary.uploader.destroy(publicId);
  } catch (err) {
    console.error('Cloudinary delete error:', err.message);
  }
}

module.exports = { uploadToCloudinary, deleteFromCloudinary };