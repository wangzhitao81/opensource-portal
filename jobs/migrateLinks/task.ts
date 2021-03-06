//
// Copyright (c) Microsoft. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.
//

/*eslint no-console: ["error", { allow: ["warn", "dir", "log"] }] */

// This is a transition migration job that takes the former link source of truth -
// table links - and copies those links into the configured provider if it is different.

// Assumes the source and destination providers are of different types so
// that the default configuration is simply required for both.
//
// Also requires migration environment variables:
// LINK_MIGRATION_DESTINATION_TYPE
// LINK_MIGRATION_OVERWRITE  values : 'overwrite', 'skip'

'use strict';

// import async = require('async');
import throat = require('throat');

import { createAndInitializeLinkProviderInstance } from '../../lib/linkProviders';
import { IProviders } from '../../transitional';
import { ILinkProvider } from '../../lib/linkProviders/postgres/postgresLinkProvider';
import { ICorporateLink } from '../../business/corporateLink';

module.exports = function run(config) {
  const app = require('../../app');
  config.skipModules = new Set([
    'web',
  ]);

  app.initializeApplication(config, null, error => {
    if (error) {
      throw error;
    }
    migration(config, app).then(done => {
      console.log('done');
      process.exit(0);
    }).catch(error => {
      throw error;
    });
  });
};

async function migration(config, app) : Promise<void> {
  const providers = app.settings.providers as IProviders;
  // const sourceLinkProvider = providers.linkProvider;

  const sourceLinkProviderName = 'table';
  console.log(`creating source ${sourceLinkProviderName} provider`);
  const sourceLinkProvider = await createAndInitializeLinkProviderInstance(providers, config, sourceLinkProviderName);

  const destinationLinkProviderName = 'postgres';

  console.log(`creating destination ${destinationLinkProviderName} provider`);
  const destinationLinkProvider = await createAndInitializeLinkProviderInstance(providers, config, destinationLinkProviderName);

  console.log('downloading all source links');
  const allSourceLinks = await getAllLinks(sourceLinkProvider);
  console.log(`SOURCE: ${allSourceLinks.length} links`);

  // const clearDestinationLinksFirst = false;

  const overwriteDestinationLinks = false;

  console.log(`migrating ${allSourceLinks.length} links...`);
  let errors = 0;
  let errorList = [];

  await Promise.all(allSourceLinks.map(throat<string, (sourceLink: ICorporateLink) => Promise<string>>(async sourceLink => {
    const existingLink = await getThirdPartyLink(destinationLinkProvider, sourceLink.thirdPartyId);
    if (existingLink && overwriteDestinationLinks) {
      console.warn('Removing existing destination link...');
      await deleteLink(destinationLinkProvider, existingLink);
    } else if (existingLink && overwriteDestinationLinks === false) {
      return '$';
    }

    console.log(`Creating link in destination provider for corp ${sourceLink.corporateUsername} 3p ${sourceLink.thirdPartyUsername}...`);
    try {
      if (!sourceLink.corporateId) {
        // need to use the graph!
        const id = await getUserIdByUpn(providers.graphProvider, sourceLink.corporateUsername);
        if (id === null) {
          throw new Error(`not found user ${sourceLink.corporateUsername} in graph`);
        }
        console.log(`discovered id ${id} for upn ${sourceLink.corporateUsername}`);
        sourceLink.corporateId = id;
      }

      const newLinkId = await createNewLink(destinationLinkProvider, sourceLink);
      console.log(`OK: new link ID in destination: ${newLinkId}`);
    } catch (linkCreateError) {
      console.log('Issue with link:');
      console.dir(sourceLink);
      console.warn(linkCreateError);
      ++errors;
      errorList.push(linkCreateError);
      return 'e';
      // throw linkCreateError;
    }
    console.log('[next]');
    return 'x';
  }, 5)));

  console.log('All done with ' + errors + ' errors');
  console.dir(errorList);
  console.log();
}

async function getThirdPartyLink(linkProvider: ILinkProvider, thirdPartyId: string) : Promise<ICorporateLink> {
  return new Promise<ICorporateLink>((resolve, reject) => {
    linkProvider.getByThirdPartyId(thirdPartyId, (error, link: ICorporateLink) => {
      if (error && error['status'] === 404) {
        error = null;
      }
      if (error) {
        return reject(error);
      }
      return resolve(link);
    });
  });
}

async function getUserIdByUpn(graphProvider, upn: string) : Promise<string> {
  return new Promise<string>((resolve, reject) => {
    graphProvider.getUserById(upn, (err, info) => {
      if (err && err['status'] === 404) {
        console.log('User no longer around');
        return resolve(null);
      }
      if (err) {
        return reject(err);
      }
      return resolve(info.id);
    });

  });
}

async function createNewLink(linkProvider: ILinkProvider, link: ICorporateLink) : Promise<string> {
  return new Promise<string>((resolve, reject) => {
    linkProvider.createLink(link, (error, linkId: string) => {
      if (error) {
        return reject(error);
      }
      return resolve(linkId);
    });
  });
}

async function deleteLink(linkProvider: ILinkProvider, link: ICorporateLink) : Promise<void> {
  return new Promise<void>((resolve, reject) => {
    linkProvider.deleteLink(link, (error, wasDeleted: boolean) => {
      if (error) {
        return reject(error);
      }
      return resolve();
    });
  });
}

async function getAllLinks(linkProvider: ILinkProvider) : Promise<ICorporateLink[]> {
  return new Promise<ICorporateLink[]>((resolve, reject) => {
    linkProvider.getAll((error, links: ICorporateLink[]) => {
      if (error) {
        return reject(error);
      }
      return resolve(links);
    });
  });
}
