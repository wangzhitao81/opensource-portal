//
// Copyright (c) Microsoft. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.
//

import express = require('express');
const router = express.Router();
import async = require('async');

import { ReposAppRequest } from '../transitional';

import { requirePortalAdministrationPermission } from '../middleware/business/administration';
import { ILinkProvider, PostgresLinkProvider } from '../lib/linkProviders/postgres/postgresLinkProvider';
import { Operations } from '../business/operations';
import { ICorporateLink } from '../business/corporateLink';
import { Organization } from '../business/organization';
import { CorporateLinkPostgres } from '../lib/linkProviders/postgres/postgresLink';

// - - - Middleware: require that the user isa portal administrator to continue
router.use(requirePortalAdministrationPermission);
// - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -

// These functions are not pretty.

enum OperationsAction {
  DestroyLink,
  MarkAsServiceAccount,
  UnmarkServiceAccount,
}

enum UserQueryByType {
  ByGitHubId,
  ByGitHubUsername,
  ByCorporateUsername,
}

interface IUserInformationQuery {
  queryByValue: string;
  queryByType: UserQueryByType;

  link?: ICorporateLink;
  noLinkButKnownThirdPartyId?: string;

  orgs?: Organization[];
  gitHubUserInfo?: any;
  renamedGitHubUserOutcome?: UserQueryOutcomeRenamedThirdPartyUsername;
  deletedGitHubUserOutcome?: any;
  personEntry?: any;
  realtimeGraph?: any;
  realtimeGraphError?: any;
}

class UserQueryOutcomeRenamedThirdPartyUsername {
  public username: string;
  public message: string;

  constructor(newUsername: string, knownPreviousUsername?: string, differentMessage?: string) {
    this.username = newUsername;
    if (!knownPreviousUsername) {
      this.message = `The username was renamed to ${newUsername}`;
    } else {
      this.message = `The user previously known as ${knownPreviousUsername} is now ${newUsername}`;
    }
    if (differentMessage) {
      this.message = differentMessage;
    }
  }
}

router.get('/', function (req: ReposAppRequest, res) {
  req.individualContext.webContext.render({
    view: 'organization/index',
    title: 'Organization Dashboard',
  })
});

async function queryByGitHubLogin(operations: Operations, graphProvider: any, redisClient: any, login: string): Promise<IUserInformationQuery> {
  const query : IUserInformationQuery = {
    queryByType: UserQueryByType.ByGitHubUsername,
    queryByValue: login,
  };
  const linkProvider = operations.linkProvider;
  let gitHubAccountInfo = null;
  try {
    gitHubAccountInfo = await getGitHubAccountInformationByLogin(operations, login);
  } catch (error) {
    // They may have renamed their GitHub username, but the ID is the same as it was before...
    if (error && error.statusCode === 404) {
      const linkByOldName = await getLinkByThirdPartyUsername(operations, graphProvider, redisClient, login) as ICorporateLink;
      if (linkByOldName && linkByOldName.thirdPartyId) {
        const anotherTryGitHubId = linkByOldName.thirdPartyId;
        query.link = linkByOldName;
        gitHubAccountInfo = await getGitHubAccountInformationById(operations, anotherTryGitHubId);
        query.gitHubUserInfo = gitHubAccountInfo;
        error = null;
      }
    }
    if (error) {
      throw error;
    }
  }
  if (!query.link && gitHubAccountInfo && gitHubAccountInfo.login) {
    try {
      query.link = await getLinkByThirdPartyUsername(operations, graphProvider, redisClient, gitHubAccountInfo.login);
    } catch (queryByLoginAttempt) {
      query.noLinkButKnownThirdPartyId = gitHubAccountInfo.id;
      if (queryByLoginAttempt.status == 404 /* loose*/) {
        console.warn('Not linked');
      } else {
        console.dir(queryByLoginAttempt);
      }
    }
  }
  return loadInformation(operations, graphProvider, redisClient, query);
}

function getLinkByThirdPartyUsername(operations: Operations, graphProvider: any, redisClient: any, login: string): Promise<ICorporateLink> {
  return new Promise((resolve, reject) => {
    const linkProvider = operations.linkProvider;
    linkProvider.getByThirdPartyUsername(login, (error, link: ICorporateLink) => {
      return error ? reject(error) : resolve(link);
    });
  });
}

function queryByGitHubId(operations: Operations, graphProvider: any, redisClient: any, thirdPartyId: string): Promise<IUserInformationQuery> {
  return new Promise((resolve, reject) => {
    const linkProvider = operations.linkProvider;
    linkProvider.getByThirdPartyId(thirdPartyId, (error, link: ICorporateLink) => {
      if (error) {
        return reject(error);
      }
      const query : IUserInformationQuery = {
        queryByType: UserQueryByType.ByGitHubId,
        queryByValue: thirdPartyId,
      };
      if (link) {
        query.link = link;
      } else {
        query.noLinkButKnownThirdPartyId = thirdPartyId;
      }
      return loadInformation(operations, graphProvider, redisClient, query).then(resolve).catch(reject);
    });
  });
}

function queryByCorporateUsername(operations: Operations, graphProvider: any, redisClient: any, upn: string): Promise<IUserInformationQuery> {
  return new Promise((resolve, reject) => {
    const linkProvider = operations.linkProvider;
    linkProvider.queryByCorporateUsername(upn, function (error, links: ICorporateLink[]) {
      if (!error && (!links || links.length !== 1)) {
        if (!links || links.length <= 0) {
          error = new Error(`No links were identified for the corporate username ${upn}`);
        } else {
          error = new Error(`Too many links (more than one) exist for the corporate username ${upn}`);
        }
      }
      if (error) {
        return reject(error);
      }
      const query : IUserInformationQuery = {
        queryByType: UserQueryByType.ByCorporateUsername,
        queryByValue: upn,
        link: links[0],
      };
      return loadInformation(operations, graphProvider, redisClient, query).then(resolve).catch(reject);
    });
  });
}

async function loadInformation(operations: Operations, graphProvider: any, redisClient: any, query: IUserInformationQuery) : Promise<IUserInformationQuery> {
  // Input: query type and value; pre-queried and set single link, if present

  // Lookup person entry as exposed by our people data
  const corporateUpn = query.link ? query.link.corporateUsername : null;
  if (corporateUpn) {
    query.personEntry = await getPersonEntryByUpn(redisClient, query.link.corporateUsername);
  }

  const corporateAadId = query.link ? query.link.corporateId : null;
  if (corporateAadId) {
    try {
      query.realtimeGraph = await getMicrosoftGraphAadIdInformation(graphProvider, corporateAadId);
    } catch (graphError) {
      query.realtimeGraphError = graphError;
    }
  }

  // Get user account information from GitHub
  let thirdPartyId = query.link ? query.link.thirdPartyId : query.noLinkButKnownThirdPartyId;
  if (query.gitHubUserInfo && query.gitHubUserInfo.id) {
    // In the scenario that they have renamed their account, this may come up...
    thirdPartyId = query.gitHubUserInfo.id;
  }
  let thirdPartyUsername: string = null;
  try {
    if (thirdPartyId) {
      const account = await getGitHubAccountInformationById(operations, thirdPartyId);
      query.gitHubUserInfo = account;
      const login = account.login;
      if (query.link && login !== query.link.thirdPartyUsername) {
        query.renamedGitHubUserOutcome = new UserQueryOutcomeRenamedThirdPartyUsername(login, query.link.thirdPartyUsername);
      }
      thirdPartyUsername = login;
    }
  } catch (ignoreGetAccountError) {
    if (ignoreGetAccountError && ignoreGetAccountError.code === '404') {
      thirdPartyUsername = query.link ? query.link.thirdPartyUsername : null;
      if (thirdPartyUsername) {
        let deletedAccountError = null;
        let moreInfo = null;
        try {
          moreInfo = await getGitHubAccountInformationByLogin(operations, thirdPartyUsername);
        } catch (deletedAccountCatch) {
          if (deletedAccountCatch && deletedAccountCatch.code === '404') {
            deletedAccountError = deletedAccountCatch;
            query.deletedGitHubUserOutcome = `The GitHub account '${thirdPartyUsername}' (ID ${thirdPartyId}) has been deleted`;
          } else {
            throw deletedAccountError;
          }
        }
        query.gitHubUserInfo = moreInfo;
        if (moreInfo && moreInfo.id != /* loose compare */ thirdPartyId) {
          const newId = moreInfo.id;
          query.renamedGitHubUserOutcome = new UserQueryOutcomeRenamedThirdPartyUsername(thirdPartyUsername, thirdPartyUsername, `The original GitHub username this user linked with, ${thirdPartyUsername}, exists. However, the user ID is different now. It was ${thirdPartyId} and now the ID is ${newId}. They most likely deleted their old account or have two-factor problems.`);
        }
      }
    } else {
      console.warn(ignoreGetAccountError);
    }
  }

  // Learn about all the org memberships for the username
  if (thirdPartyUsername) {
    const loginMemberships = await getGitHubOrganizationMembershipInformation(operations, thirdPartyUsername);
    query.orgs = loginMemberships;
  }

  return query;
}

function getGitHubAccountInformationById(operations: Operations, id: string) : Promise<any> {
  return new Promise((resolve, reject) => {
    const account = operations.getAccount(id);
    account.getDetails(getUsernameError => {
      return getUsernameError ? reject(getUsernameError) : resolve(account);
    });
  });
}

function getGitHubAccountInformationByLogin(operations: Operations, login: string) : Promise<any> {
  return new Promise((resolve, reject) => {
    operations.getAccountByUsername(login, {}, (getError, accountInfo) => {
      return getError ? reject(getError) : resolve(accountInfo);
    });
  });
}

function getGitHubOrganizationMembershipInformation(operations: Operations, login: string) : Promise<Organization[]> {
  return new Promise((resolve, reject) => {
    const orgsList = operations.organizations;
    const orgsUserIn = [];
    async.each(orgsList, function (organization, next) {
      organization.getMembership(login, function (err, membership) {
        if (membership && membership.state) {
          orgsUserIn.push(organization);
        }
        return next();
      });
    }, function (/*expansionErrorIgnored*/) {
      return resolve(orgsUserIn);
    });
  });
}

function getPersonEntryByUpn(redisClient, upn: string) : Promise<any> {
  return new Promise((resolve, reject) => {
    redisClient.hget('upns', upn, (redisGetError, data) => {
      if (redisGetError) {
        return reject(redisGetError);
      }
      var person = null;
      if (data) {
        try {
          person = JSON.parse(data);
        } catch (jsonError) {
          return reject(jsonError);
        }
      }
      if (person) {
        return resolve(person);
      }
      return resolve(null);
    });
  });
}

function getMicrosoftGraphAadIdInformation(graphProvider, aadId: string) : Promise<any> {
  return new Promise((resolve, reject) => {
    if (!graphProvider || !aadId) {
      return resolve();
    }
    graphProvider.getUserAndManagerById(aadId, (error, info) => {
      return error ? reject(error) : resolve(info);
    });
  });
}


router.get('/whois/id/:githubid', function (req: ReposAppRequest, res, next) {
  const thirdPartyId = req.params.githubid;
  const operations = req.app.settings.providers.operations as Operations;
  const graphProvider = req.app.settings.providers.graphProvider;
  const redisClient = req.app.settings.providers.redisClient;
  queryByGitHubId(operations, graphProvider, redisClient, thirdPartyId).then(query => {
    req.individualContext.webContext.render({
      view: 'organization/whois/result',
      title: `Whois by GitHub ID: ${thirdPartyId}`,
      state: {
        personEntry: query.personEntry,
        info: query.gitHubUserInfo,
        realtimeGraph: query.realtimeGraph,

        postUrl: `/organization/whois/id/${thirdPartyId}`,

        // new-style
        query,
      },
    });
  }).catch(next);
});

enum IDValueType {
  ID,
  Username,
}

interface IIDValue {
  type: IDValueType;
  value: string;
}

router.get('/whois/link/:linkid', function (req: ReposAppRequest, res, next) {
  const linkId = req.params.linkid;
  const operations = req.app.settings.operations as Operations;
  const linkProvider = operations.linkProvider as PostgresLinkProvider;
  linkProvider.getByPostgresLinkId(linkId, (getError, link: ICorporateLink) => {
    if (getError) {
      return next(getError);
    }
    return req.individualContext.webContext.render({
      view: 'organization/whois/linkEditorPage',
      title: `Link ${linkId}`,
      state: {
        query: {
          link,
        }
      },
    });
  });
});

router.post('/whois/link/:linkid', function (req: ReposAppRequest, res, next) {
  const linkId = req.params.linkid;
  const keys = [
    'corporateId',
    'corporateUsername',
    'corporateDisplayName',
    'thirdPartyId',
    'thirdPartyUsername',
    'thirdPartyAvatar',
  ];
  for (const key of keys) {
    if (!req.body[key]) {
      return next(new Error(`Must provide a value for ${key}`));
    }
    break;
  }
  const operations = req.app.settings.operations as Operations;
  const linkProvider = operations.linkProvider as PostgresLinkProvider;
  linkProvider.getByPostgresLinkId(linkId, (getError, link: CorporateLinkPostgres) => {
    if (getError) {
      return next(getError);
    }
    const messages = [
      `Link ID ${linkId}`,
    ];
    let hadUpdates = false;
    for (const key of keys) {
    // loose comparisons
    if (link[key] != req.body[key]) {
        messages.push(`${key}: value has been updated from "${link[key]}" to "${req.body[key]}"`);
        link[key] = req.body[key];
        hadUpdates = true;
      }
    }
    const renderOutput = function () {
      req.individualContext.webContext.render({
        view: 'organization/whois/linkUpdate',
        title: `Updating link ${linkId}`,
        state: {
          messages,
          linkId,
        },
      });
    };
    if (hadUpdates) {
      return linkProvider.updateLink(link, updateError => {
        if (updateError) {
          return next(updateError);
        }
        renderOutput();
      });
    } else {
      messages.push('No link values changed, it was not updated');
      return renderOutput();
    }
  });
});

router.post('/whois/id/:githubid', function (req: ReposAppRequest, res, next) {
  const thirdPartyId = req.params.githubid;
  const markAsServiceAccount = req.body['mark-as-service-account'];
  const unmarkServiceAccount = req.body['unmark-service-account'];
  const operations = req.app.settings.operations as Operations;
  const graphProvider = req.app.settings.providers.graphProvider;
  const redisClient = req.app.settings.providers.redisClient;
  let action = OperationsAction.DestroyLink;
  if (markAsServiceAccount) {
    action = OperationsAction.MarkAsServiceAccount;
  } else if (unmarkServiceAccount) {
    action = OperationsAction.UnmarkServiceAccount;
  }
  const idValue: IIDValue = {
    type: IDValueType.ID,
    value: thirdPartyId,
  };
  destructiveLogic(operations, graphProvider, redisClient, idValue, action, req, res, next).then(state => {
    if (state.independentView) {
      return;
    }
    req.individualContext.webContext.render({
      view: 'organization/whois/drop',
      title: `Dropped link by ID ${thirdPartyId}`,
      state,
    });
  }).catch(error => {
    return next(error);
  });
});

router.get('/whois/aad/:upn', function (req: ReposAppRequest, res, next) {
  const upn = req.params.upn;
  const operations = req.app.settings.providers.operations as Operations;
  const graphProvider = req.app.settings.providers.graphProvider;
  const redisClient = req.app.settings.providers.redisClient;
  queryByCorporateUsername(operations, graphProvider, redisClient, upn).then(query => {
    req.individualContext.webContext.render({
      view: 'organization/whois/result',
      title: `Whois by AAD UPN: ${upn}`,
      state: {
        personEntry: query.personEntry,
        upn: upn,
        info: query.gitHubUserInfo,
        realtimeGraph: query.realtimeGraph,

        // new-style
        query,
      },
    });
  }).catch(next);
});

router.get('/whois/github/:username', function (req: ReposAppRequest, res, next) {
  const login = req.params.username;
  const operations = req.app.settings.providers.operations;
  const graphProvider = req.app.settings.providers.graphProvider;
  const redisClient = req.app.settings.providers.redisClient;
  queryByGitHubLogin(operations, graphProvider, redisClient, login).then(query => {
    req.individualContext.webContext.render({
      view: 'organization/whois/result',
      title: `Whois: ${login}`,
      state: {
        personEntry: query.personEntry,
        info: query.gitHubUserInfo,
        realtimeGraph: query.realtimeGraph,

        // new-style
        query,
      },
    });
  }).catch(next);
});

router.post('/whois/github/:username', function (req: ReposAppRequest, res, next) {
  const username = req.params.username;
  const markAsServiceAccount = req.body['mark-as-service-account'];
  const unmarkServiceAccount = req.body['unmark-service-account'];
  const operations = req.app.settings.operations as Operations;
  const graphProvider = req.app.settings.providers.graphProvider;
  const redisClient = req.app.settings.providers.redisClient;
  let action = OperationsAction.DestroyLink;
  if (markAsServiceAccount) {
    action = OperationsAction.MarkAsServiceAccount;
  } else if (unmarkServiceAccount) {
    action = OperationsAction.UnmarkServiceAccount;
  }
  const identifier : IIDValue = {
    type: IDValueType.Username,
    value: username,
  };
  destructiveLogic(operations, graphProvider, redisClient, identifier, action, req, res, next).then(state => {
    if (state.independentView) {
      return;
    }
    req.individualContext.webContext.render({
      view: 'organization/whois/drop',
      title: `Dropped ${username}`,
      state,
    });
  }).catch(error => {
    return next(error);
  });
});

async function destructiveLogic(operations: Operations, graphProvider, redisClient, identifier: IIDValue, action: OperationsAction, req, res, next): Promise<any> {
  let usernameInfo = null;
  let state = {
    results: null,
    entity: null,
    messages: [],
    independentView: false,
  };
  let thirdPartyUsername = identifier.type === IDValueType.Username ? identifier.value : null;
  let thirdPartyId = identifier.type === IDValueType.ID ? identifier.value : null;
  try {
    if (!thirdPartyUsername) {
      state.messages.push('Destruction operation not requested on a username');
    } else {
      usernameInfo = await getGitHubAccountInformationByLogin(operations, thirdPartyUsername);
      if (thirdPartyId && usernameInfo.id !== thirdPartyId) {
        state.messages.push(`The retrieved ID for the username was ${usernameInfo.id} instead of the expected ${thirdPartyId}`);
      } else if (!thirdPartyId && usernameInfo.id) {
        thirdPartyId = usernameInfo.id;
      }
    }
  } catch (grabError) {
    state.messages.push(`Could not get GitHub account information by USERNAME ${thirdPartyUsername}: ` + grabError.toString());
  }
  state.entity = usernameInfo;

  let idInfo = null;
  if (thirdPartyId) {
    try {
      idInfo = await getGitHubAccountInformationById(operations, thirdPartyId);
    } catch (idInfoError) {
      if (idInfoError.code === '404') {
        state.messages.push(`The GitHub account was deleted by ID ${thirdPartyId}: ` + idInfoError.toString());
      } else {
        state.messages.push(`Could not get GitHub account information by ID ${thirdPartyId}: ` + idInfoError.toString());
      }
    }
  }

  let linkQuery = null;
  if (thirdPartyId) {
    try {
      linkQuery = await queryByGitHubId(operations, graphProvider, redisClient, thirdPartyId);
    } catch (oops) {
      console.dir(oops);
      state.messages.push(`Could not find a corporate link by their GitHub user ID of ${thirdPartyId}`);
      if (usernameInfo && usernameInfo.login) {
        state.messages.push(`Will try next by their GitHub username: ${usernameInfo.login}`);
      }
      try {
        linkQuery = await queryByGitHubLogin(operations, graphProvider, redisClient, thirdPartyUsername);
        state.messages.push(`Did find a link by their login on GitHub, ${thirdPartyUsername}. Will terminate this ID.`);
      } catch (linkByUsernameError) {
        state.messages.push(`Could not find a link by login, ${thirdPartyUsername}. Hmm.`);
      }
    }
  }

  // Service Account settings (not so destructive)
  if (action === OperationsAction.MarkAsServiceAccount || action === OperationsAction.UnmarkServiceAccount) {
    const linkProvider = operations.linkProvider;
    state.independentView = true; // no rendering on return
    return modifyServiceAccount(linkProvider, linkQuery.link, action === OperationsAction.MarkAsServiceAccount, req, res, next);
  }

  // Account termination
  if (linkQuery && linkQuery.link) {
    state.results = await operations.terminateAccount(linkQuery.link.thirdPartyId);
  } else {
    state.messages.push('Could not terminate the account, no link was found');
  }

  return state;
}

function modifyServiceAccount(linkProvider: ILinkProvider, link: ICorporateLink, markAsServiceAccount, req, res, next) {
  link.isServiceAccount = markAsServiceAccount ? true : false;
  linkProvider.updateLink(link, updateError => {
    if (updateError) {
      return next(updateError);
    }
    res.json(link);
  });
}

// ----------------------------------------------------------------------------

router.get('/bulkRepoDelete', (req: ReposAppRequest, res) => {
  req.individualContext.webContext.render({
    view: 'organization/bulkRepoDelete',
    title: 'Bulk repository delete',
  });
});

router.post('/bulkRepoDelete', (req, res, next) => {
  const operations = req.app.settings.operations;
  let repositories = req.body.repositories;
  if (!repositories) {
    return next(new Error('No repositories provided'));
  }
  repositories = repositories.split('\n');
  const log = [];
  async.eachLimit(repositories, 1, (repositoryName, next) => {
    repositoryName = (repositoryName || '').trim();
    if (!repositoryName.length) {
      return next();
    }
    let githubcom = 'github.com';
    let ghi = repositoryName.indexOf(githubcom);
    if (ghi >= 0) {
      let name = repositoryName.substr(ghi + githubcom.length + 1);
      let divider = name.indexOf('/');
      if (divider <= 0) {
        return next();
      }
      let orgName = name.substr(0, divider);
      let repoName = name.substr(divider + 1);
      const repository = operations.getOrganization(orgName).repository(repoName);
      repository.delete((errorIsh, more) => {
        if (errorIsh) {
          log.push(name + ': ' + errorIsh);
        } else {
          let metaStatus = more && more.headers ? more.headers.status : null;
          log.push(name + ': ' + metaStatus);
        }
        return next();
      });
    } else {
      log.push(`Skipping, does not appear to be a GitHub repo URL: ${repositoryName}`);
      return next();
    }
  }, error => {
    if (error) {
      return next(error);
    }
    res.json(log);
  });
});

module.exports = router;
