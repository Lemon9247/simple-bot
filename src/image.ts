import sharp from "sharp";
import * as logger from "./logger.js";

/** Anthropic's hard limit is 5MB; target well under that. */
const MAX_BASE64_BYTES = 4 * 1024 * 1024; // 4MB
const MAX_DIMENSION = 2048;
const JPEG_QUALITY_START = 85;
const JPEG_QUALITY_MIN = 40;
const JPEG_QUALITY_STEP = 15;

export type CompressResult =
    | { ok: true; base64: string; mimeType: string }
    | { ok: false; reason: string };

/**
 * Compress an image buffer to fit under the API size limit.
 * Returns { ok: true, base64, mimeType } on success,
 * or { ok: false, reason } if the image cannot be compressed enough.
 * Returns null if the image already fits (caller should use the original).
 */
export async function compressImage(
    buf: Buffer,
    originalMime: string,
): Promise<CompressResult | null> {
    // Check dimensions even if base64 size is fine — large pixel counts
    // cost many vision tokens and may exceed API limits
    const metadata = await sharp(buf).metadata();
    const width = metadata.width ?? 0;
    const height = metadata.height ?? 0;
    const needsResize = width > MAX_DIMENSION || height > MAX_DIMENSION;

    const originalBase64 = buf.toString("base64");
    const fitsSize = Buffer.byteLength(originalBase64) <= MAX_BASE64_BYTES;

    if (fitsSize && !needsResize) {
        return null; // already fits
    }

    logger.info("Compressing image", {
        originalBytes: buf.length,
        originalMime,
        width,
        height,
        needsResize,
        fitsSize,
    });

    // Resize if dimensions are huge, then iteratively lower JPEG quality
    const pipeline = sharp(buf).resize({
        width: MAX_DIMENSION,
        height: MAX_DIMENSION,
        fit: "inside",
        withoutEnlargement: true,
    });

    for (let q = JPEG_QUALITY_START; q >= JPEG_QUALITY_MIN; q -= JPEG_QUALITY_STEP) {
        const compressed = await pipeline.clone().jpeg({ quality: q }).toBuffer();
        const b64 = compressed.toString("base64");
        if (Buffer.byteLength(b64) <= MAX_BASE64_BYTES) {
            logger.info("Image compressed", {
                quality: q,
                compressedBytes: compressed.length,
            });
            return { ok: true, base64: b64, mimeType: "image/jpeg" };
        }
    }

    // Last resort: aggressive resize + low quality
    const lastResort = await sharp(buf)
        .resize({ width: 1024, height: 1024, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: JPEG_QUALITY_MIN })
        .toBuffer();

    const lastResortB64 = lastResort.toString("base64");
    if (Buffer.byteLength(lastResortB64) <= MAX_BASE64_BYTES) {
        logger.warn("Image required aggressive compression", {
            finalBytes: lastResort.length,
        });
        return { ok: true, base64: lastResortB64, mimeType: "image/jpeg" };
    }

    // Truly incompressible
    const sizeMB = (buf.length / (1024 * 1024)).toFixed(1);
    logger.error("Image could not be compressed to fit API limits", {
        originalBytes: buf.length,
        lastResortBytes: lastResort.length,
        width,
        height,
    });

    return {
        ok: false,
        reason: `Image too large to process (${width}×${height}, ${sizeMB} MB). Could not compress below API limit.`,
    };
}
