import express from 'express';
import { ObjectStatus } from '@prisma/client';
import { prisma } from '../../core/drivers/postgres';
import { blobStorage } from '../../core/blob-storage';

const router = express.Router();


/**
 * Uploads an object to blob storage.
 * 
 * Will store in s3 or local filesystem depending on config.
 */
router.put('/:namespace/objects/:prefix/:suffix', express.raw({ type: '*/*' }), async (req, res) => {

    const namespace = req.params.namespace;
    const prefix = req.params.prefix;
    const suffix = req.params.suffix;
    const content = req.body;

    const size = parseInt(req.get('content-length')!);

    // if content-length was not sent, or it is zero, or it is not a number return 400
    if (!size || size === 0 || isNaN(size)) {
        return res.status(400).end();
    }

    const object_id = prefix + suffix;
    const bucketId = namespace + '/' + prefix + '/' + suffix;

    // do persistence layer ops in a transaction
    await prisma.$transaction(async tx => {

        await tx.object.upsert({
            create: {
                namespace,
                object_id,
                size,
                status: ObjectStatus.uploading
            },
            update: {
                size,
                status: ObjectStatus.uploading
            },
            where: {
                _object_id: {
                    namespace,
                    object_id
                }
            }
        });

        await blobStorage.putObject(bucketId, content);

        await tx.object.update({
            where: {
                namespace_object_id: {
                    namespace,
                    object_id
                }
            },
            data: {
                status: ObjectStatus.uploaded
            }
        });
    });

    return res.status(200).end();

});


/**
 * Gets an object from blob storage.
 * 
 * Will fetch from s3 or local filesystem depending on config.
 */
router.get('/:namespace/objects/:prefix/:suffix', async (req, res) => {

    const namespace = req.params.namespace;
    const prefix = req.params.prefix;
    const suffix = req.params.suffix;

    const object_id = prefix + suffix;
    const bucketId = namespace + '/' + prefix + '/' + suffix;

    const object = await prisma.object.findUnique({
        where: {
            namespace_object_id: {
                namespace,
                object_id
            }
        }
    });

    if (!object) {
        return res.status(404).end();
    }

    const content = await blobStorage.getObject(bucketId);

    if (!content) {
        // db and blob storage should be in sync
        // if an object exists in db but not blob storage something has gone wrong, bail on this request
        return res.status(500).end();
    }

    res.set('content-type', 'application/octet-stream');
    return res.status(200).send(content);

});


export default router;