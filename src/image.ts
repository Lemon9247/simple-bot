import sharp from "sharp";
import * as logger from "./logger.js";

/** Anthropic's hard limit is 5MB; target well under that. */
const MAX_BASE64_BYTES = 4 * 1024 * 1024; // 4MB
const MAX_DIMENSION = 2048;
const JPEG_QUALITY_START = 85;
const JPEG_QUALITY_MIN = 40;
const JPEG_QUALITY_STEP = 15;

/**
 * Compress an image buffer to fit under the API size limit.
 * Returns { data: base64string, mimeType } or null if the image
 * is already small enough (caller should use the original).
 */
export async function compressImage(
    buf: Buffer,
    originalMime: string,
): Promise<{ base64: string; mimeType: string } | null> {
    const originalBase64 = buf.toString("base64");
    if (Buffer.byteLength(originalBase64) <= MAX_BASE64_BYTES) {
        return null; // already fits
    }

    logger.info("Compressing oversized image", {
        originalBytes: buf.length,
        originalMime,
    });

    // Resize if dimensions are huge, then iteratively lower JPEG quality
    let pipeline = sharp(buf).resize({
        width: MAX_DIMENSION,
        height: MAX_DIMENSION,
        fit: "inside",
        withoutEnlargement: true,
    });

    for (let q = JPEG_QUALITY_START; q >= JPEG_QUALITY_MIN; q -= JPEG_QUALITY_STEP) {
        const compressed = await pipeline.jpeg({ quality: q }).toBuffer();
        const b64 = compressed.toString("base64");
        if (Buffer.byteLength(b64) <= MAX_BASE64_BYTES) {
            logger.info("Image compressed", {
                quality: q,
                compressedBytes: compressed.length,
            });
            return { base64: b64, mimeType: "image/jpeg" };
        }
    }

    // Last resort: aggressive resize + low quality
    const lastResort = await sharp(buf)
        .resize({ width: 1024, height: 1024, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: JPEG_QUALITY_MIN })
        .toBuffer();

    logger.warn("Image required aggressive compression", {
        finalBytes: lastResort.length,
    });

    return {
        base64: lastResort.toString("base64"),
        mimeType: "image/jpeg",
    };
}
