import { MessagePortMain } from 'electron';
import rawLog from 'electron-log'
import ORMConnection from '@/common/appdb/Connection'
import platformInfo from '@/common/platform_info';
import { AppDbHandlers } from '@/handlers/appDbHandlers';
import { ConnHandlers } from '../backend/handlers/connHandlers';
import { FileHandlers } from '@/handlers/fileHandlers';
import { GeneratorHandlers } from '@/handlers/generatorHandlers';
import { Handlers } from '../backend/handlers/handlers';
import { newState, removeState, state } from '@/handlers/handlerState';
import { QueryHandlers } from '@/handlers/queryHandlers';
import { ExportHandlers } from '@commercial/backend/handlers/exportHandlers';
import { BackupHandlers } from '@commercial/backend/handlers/backupHandlers';
import { ImportHandlers } from '@commercial/backend/handlers/importHandlers';
import { EnumHandlers } from '@commercial/backend/handlers/enumHandlers';
import { TempHandlers } from '@/handlers/tempHandlers';
import { DevHandlers } from '@/handlers/devHandlers';
import { LicenseHandlers } from '@/handlers/licenseHandlers';
import { LicenseKey } from '@/common/appdb/models/LicenseKey';
import { CloudClient } from '@/lib/cloud/CloudClient';
import { CloudError } from '@/lib/cloud/ClientHelpers';
import globals from '@/common/globals';

import * as sms from 'source-map-support'

if (platformInfo.env.development || platformInfo.env.test) {
  sms.install()
}

const log = rawLog.scope('UtilityProcess');

let ormConnection: ORMConnection;

interface Reply {
  id: string,
  type: 'reply' | 'error',
  data?: any,
  error?: string
  stack?: string
}

export let handlers: Handlers = {
  ...ConnHandlers,
  ...QueryHandlers,
  ...GeneratorHandlers,
  ...ExportHandlers,
  ...ImportHandlers,
  ...AppDbHandlers,
  ...BackupHandlers,
  ...FileHandlers,
  ...EnumHandlers,
  ...TempHandlers,
  ...LicenseHandlers,
  ...(platformInfo.isDevelopment && DevHandlers),
};

process.on('uncaughtException', (error) => {
  log.error(error);
});

process.parentPort.on('message', async ({ data, ports }) => {
  const { type, sId } = data;
  switch (type) {
    case 'init':
      if (ports && ports.length > 0) {
        log.info('RECEIVED PORT: ', ports[0]);
        await initState(sId, ports[0]);
      } else {
        await init();
      }
      break;
    case 'close':
      log.info('REMOVING STATE FOR: ', sId);
      state(sId).port.close();
      removeState(sId);
      break;
    default:
      log.error('UNRECOGNIZED MESSAGE TYPE RECEIVED FROM MAIN PROCESS');
  }
})

async function runHandler(id: string, name: string, args: any) {
  log.info('RECEIVED REQUEST FOR NAME, ID: ', name, id);
  const replyArgs: Reply = {
    id,
    type: 'reply',
  };

  if (handlers[name]) {
    return handlers[name](args)
      .then((data) => {
        replyArgs.data = data;
      })
      .catch((e) => {
        replyArgs.type = 'error';
        replyArgs.stack = e?.stack;
        replyArgs.error = e?.message ?? e;
        log.error("HANDLER: ERROR", e)
      })
      .finally(() => {
        try {
          state(args.sId).port.postMessage(replyArgs);
        } catch (e) {
          log.error('ERROR SENDING MESSAGE: ', replyArgs, '\n\n\n ERROR: ', e)
        }
      });
  } else {
    replyArgs.type = 'error';
    replyArgs.error = `Invalid handler name: ${name}`;

    try {
      state(args.sId).port.postMessage(replyArgs);
    } catch (e) {
      log.error('ERROR SENDING MESSAGE: ', replyArgs, '\n\n\n ERROR: ', e)
    }
  }

}

async function initState(sId: string, port: MessagePortMain) {
  newState(sId);

  state(sId).port = port;

  state(sId).port.on('message', ({ data }) => {
    const { id, name, args } = data;
    runHandler(id, name, args);
  })

  state(sId).port.start();
}

async function init() {
  ormConnection = new ORMConnection(platformInfo.appDbPath, false);
  await ormConnection.connect();

  await updateLicenses();
  setInterval(updateLicenses, globals.licenseUtilityCheckInterval);

  process.parentPort.postMessage({ type: 'ready' });
}

async function updateLicenses() {
  const licenses = await LicenseKey.all()
  const promises = licenses.map(async (license) => {
    try {
      const data = await CloudClient.getLicense(platformInfo.cloudUrl, license.email, license.key)
      license.validUntil = new Date(data.validUntil)
      license.supportUntil = new Date(data.supportUntil)
      license.maxAllowedAppRelease = data.maxAllowedAppRelease
      await license.save()
    } catch (error) {
      if (error instanceof CloudError) {
        // eg 403, 404, license not valid
        license.validUntil = new Date()
        await license.save()
      } else {
        // eg 500 errors
        // do nothing
      }
    }
  })
  await Promise.all(promises)
}