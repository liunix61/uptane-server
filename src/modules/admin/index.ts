import express from 'express';
import { TUFRepo, TUFRole } from '@prisma/client';
import forge from 'node-forge';
import { prisma } from '../../core/postgres';
import config from '../../config';
import { generateCertificate, generateKeyPair } from '../../core/crypto';
import { keyStorage } from '../../core/key-storage';
import { blobStorage } from '../../core/blob-storage';
import { generateRoot } from '../../core/tuf';
import { logger } from '../../core/logger';

const router = express.Router();


/**
 * Initialises a namespace
 * 
 * - Creates namespace in db.
 * - Creats bucket in blob storage to hold its blobs.
 * - Generates online TUF keys.
 * - Creates initial image and director root.json metadata files and saves them to the db.
 * - Creates a root CA for this namespace.
 */
router.post('/namespaces', async (req, res) => {

    // generate 8 TUF key pairs, 4 top-level metadata keys for 2 repos
    // generate a single root ca key pair
    // NOTE unify how keys are generated
    const imageRootKey = generateKeyPair(config.KEY_TYPE);
    const imageTargetsKey = generateKeyPair(config.KEY_TYPE);
    const imageSnapshotKey = generateKeyPair(config.KEY_TYPE);
    const imageTimestampKey = generateKeyPair(config.KEY_TYPE);

    const directorRootKey = generateKeyPair(config.KEY_TYPE);
    const directorTargetsKey = generateKeyPair(config.KEY_TYPE);
    const directorSnapshotKey = generateKeyPair(config.KEY_TYPE);
    const directorTimestampKey = generateKeyPair(config.KEY_TYPE);

    const rootCaKeyPair = forge.pki.rsa.generateKeyPair(2048);

    // generate root ca cert, this is the root cert so we don't pass in a parent
    const rootCert = generateCertificate(rootCaKeyPair);


    // create initial root.json for TUF repos, we'll start them off at 1
    const version = 1;

    // generate directory repo root.json
    const directorRepoRoot = generateRoot(config.TUF_TTL.DIRECTOR.ROOT,
        version,
        directorRootKey,
        directorTargetsKey,
        directorSnapshotKey,
        directorTimestampKey
    );

    // generate image repo root.json
    const imageRepoRoot = generateRoot(config.TUF_TTL.IMAGE.ROOT,
        version,
        imageRootKey,
        imageTargetsKey,
        imageSnapshotKey,
        imageTimestampKey
    );


    // do persistance layer operations in a transaction
    const namespace = await prisma.$transaction(async tx => {

        // create namespace in db
        const namespace = await tx.namespace.create({
            data: {}
        });

        // create image repo root.json in db
        await tx.metadata.create({
            data: {
                namespace_id: namespace.id,
                repo: TUFRepo.image,
                role: TUFRole.root,
                version,
                value: imageRepoRoot as object,
                expires_at: imageRepoRoot.signed.expires
            }
        });

        // create director repo root.json in db
        await tx.metadata.create({
            data: {
                namespace_id: namespace.id,
                repo: TUFRepo.director,
                role: TUFRole.root,
                version,
                value: directorRepoRoot as object,
                expires_at: directorRepoRoot.signed.expires
            }
        });

        // create bucket in blob storage
        await blobStorage.createBucket(namespace.id);

        // store the cert in blob storage, its a public cert so no harm putting it there
        await blobStorage.putObject(namespace.id, 'rootca', forge.pki.certificateToPem(rootCert));

        // store root ca keys
        await keyStorage.putKey(`${namespace.id}-rootca-private`, forge.pki.privateKeyToPem(rootCaKeyPair.privateKey));
        await keyStorage.putKey(`${namespace.id}-rootca-public`, forge.pki.publicKeyToPem(rootCaKeyPair.publicKey));

        // store image repo private keys
        await keyStorage.putKey(`${namespace.id}-image-root-private`, imageRootKey.privateKey);
        await keyStorage.putKey(`${namespace.id}-image-targets-private`, imageTargetsKey.privateKey);
        await keyStorage.putKey(`${namespace.id}-image-snapshot-private`, imageSnapshotKey.privateKey);
        await keyStorage.putKey(`${namespace.id}-image-timestamp-private`, imageTimestampKey.privateKey);

        // store image repo public keys
        await keyStorage.putKey(`${namespace.id}-image-root-public`, imageRootKey.publicKey);
        await keyStorage.putKey(`${namespace.id}-image-targets-public`, imageTargetsKey.publicKey);
        await keyStorage.putKey(`${namespace.id}-image-snapshot-public`, imageSnapshotKey.publicKey);
        await keyStorage.putKey(`${namespace.id}-image-timestamp-public`, imageTimestampKey.publicKey);

        // store director repo private keys
        await keyStorage.putKey(`${namespace.id}-director-root-private`, directorRootKey.privateKey);
        await keyStorage.putKey(`${namespace.id}-director-targets-private`, directorTargetsKey.privateKey);
        await keyStorage.putKey(`${namespace.id}-director-snapshot-private`, directorSnapshotKey.privateKey);
        await keyStorage.putKey(`${namespace.id}-director-timestamp-private`, directorTimestampKey.privateKey);

        // store director repo public keys
        await keyStorage.putKey(`${namespace.id}-director-root-public`, directorRootKey.publicKey);
        await keyStorage.putKey(`${namespace.id}-director-targets-public`, directorTargetsKey.publicKey);
        await keyStorage.putKey(`${namespace.id}-director-snapshot-public`, directorSnapshotKey.publicKey);
        await keyStorage.putKey(`${namespace.id}-director-timestamp-public`, directorTimestampKey.publicKey);

        return namespace;

    });

    const response = {
        id: namespace.id,
        created_at: namespace.created_at,
        updated_at: namespace.updated_at
    };

    logger.info('created a namespace');
    return res.status(200).json(response);

});


/**
 * List namespaces
 */
router.get('/namespaces', async (req, res) => {

    const namespaces = await prisma.namespace.findMany({
        orderBy: {
            created_at: 'desc'
        }
    });

    const response = namespaces.map(namespace => ({
        id: namespace.id,
        created_at: namespace.created_at,
        updated_at: namespace.updated_at
    }))

    return res.status(200).json(response);

});


/**
 * Delete a namespace
 * 
 * - Deletes namespace in db, this cascades to all resources.
 * - Deletes bucket and all objects in blob storage.
 * - Deletes keys, images and treehub objects associated with this namespace.
 */
router.delete('/namespaces/:namespace', async (req, res) => {

    const namespace = req.params.namespace;

    const namespaceCount = await prisma.namespace.count({
        where: {
            id: namespace
        }
    });

    if (namespaceCount === 0) {
        logger.warn('could not delete a namespace because it does not exist');
        return res.status(400).send('could not delete namespace');
    }

    await prisma.$transaction(async tx => {

        // delete namespace in db
        await tx.namespace.delete({
            where: {
                id: namespace
            }
        });

        // deletes bucket in blob storage
        await blobStorage.deleteBucket(namespace);

        // delete keys associated with this namespace
        await keyStorage.deleteKey(`${namespace}-rootca-private`);
        await keyStorage.deleteKey(`${namespace}-rootca-public`);

        await keyStorage.deleteKey(`${namespace}-image-root-private`);
        await keyStorage.deleteKey(`${namespace}-image-targets-private`);
        await keyStorage.deleteKey(`${namespace}-image-snapshot-private`);
        await keyStorage.deleteKey(`${namespace}-image-timestamp-private`);

        await keyStorage.deleteKey(`${namespace}-image-root-public`);
        await keyStorage.deleteKey(`${namespace}-image-targets-public`);
        await keyStorage.deleteKey(`${namespace}-image-snapshot-public`);
        await keyStorage.deleteKey(`${namespace}-image-timestamp-public`);

        await keyStorage.deleteKey(`${namespace}-director-root-private`);
        await keyStorage.deleteKey(`${namespace}-director-targets-private`);
        await keyStorage.deleteKey(`${namespace}-director-snapshot-private`);
        await keyStorage.deleteKey(`${namespace}-director-timestamp-private`);

        await keyStorage.deleteKey(`${namespace}-director-root-public`);
        await keyStorage.deleteKey(`${namespace}-director-targets-public`);
        await keyStorage.deleteKey(`${namespace}-director-snapshot-public`);
        await keyStorage.deleteKey(`${namespace}-director-timestamp-public`);

    });

    logger.info('deleted a namespace');
    return res.status(200).send('namespace deleted');

});



export default router;