const config = require('./config');
const GitHubApi = require('github');

class Bot {

  constructor() {
    this.github = new GitHubApi({ version: '3.0.0' });

    if ((!config.github.user || !config.github.password) && !config.github.oauth2token) {
      throw Error('[fatal] No username/password or no Oauth2 token configured!');
    }

    if (config.github.oauth2token) {
      this.github.authenticate({
        type: 'oauth',
        token: config.github.oauth2token
      });
    } else {
      this.github.authenticate({
        type: 'basic',
        username: config.github.user,
        password: config.github.password
      });
    }
  }

  canReview (pr, callback) {
    this.getLabels(pr, labels => {
      const result = labels.filter(item => item.name === config.github.label.dontReview || item.name === config.github.label.checked);
      callback(result.length === 0);
    })
  }

  initialSetup(pr) {
    if (pr.base.user.login !== pr.head.user.login) {
      const warningMessage = `Dude... As part of transitioning XCAF to our internal infrastructure you should use \`git push upstream\` to push in \`xcaliber-private\` instead of pushing in \`${pr.head.label}\``;
      this.postComment(pr.number, warningMessage, () => this.closePr(pr.number));
      return;
    }

    this.setReviewers(pr);
    this.selfAssignee(pr);
    this.updateLabels(pr);

    let clones = [];
    let deployedUrl = {};

    let serverLinks = `Deployment link(s): \nELNEW: ${this.getLink(config.herokuApp, pr.number)}`;
    deployedUrl['ELNEW'] = this.getLink(config.herokuApp, pr.number);

    const regression = `\nRegression Page: \n ${config.screenshotUrl}${pr.head.ref}`;

    this.doForEachClone(project => this.clonePr(pr, project, data => {
      serverLinks = `${serverLinks} \n${project}: ${data.deploy}`;
      deployedUrl[project] = data.deploy;
      clones.push(data.clone);
    }));

    let commentLinks = '';

    // Delay to wait for all the links be ready
    setTimeout(() => {
      if (config.github.instructionsComment !== '') {
        commentLinks = `${config.github.instructionsComment}\n ${commentLinks}`
      }

      if (clones.length > 0) {
        commentLinks += '\n\nCloned PR(s):'
        clones.forEach(clone => commentLinks += `\nhttps://github.com/${clone.owner}/${clone.repo}/pull/${clone.number}`);
      }

      this.getCommits(pr, resp => {
        const issues = [];
        resp.forEach(item => {
          const parsedCommit = this.parseCommit(item.commit.message);
          if (!parsedCommit.valid) {
            return;
          }

          if (issues.indexOf(parsedCommit.issue) === -1) {
            issues.push(parsedCommit.issue);
          }
        });

        if (config.jira.url && issues.length > 0) {
          commentLinks += `\n\nJira issue(s):`
          issues.forEach(issue => commentLinks += `\n${config.jira.url}browse/${issue}`)
        }

        this.postComment(pr.number, `${serverLinks}\n${commentLinks}\n${regression}`);
        this.websocket.emit('initialsetup',{
          issues,
          pr,
          deployedUrl,
          comment: `Github: https://github.com/${config.github.repoOwner}/${config.github.repo}/pull/${pr.number}\n${serverLinks}\n${regression}`,
        });
      });
    }, 5000);
  }

  setWebsocket(io) {
    this.websocket = io;
    this.websocket.on('connection', socket => {
      socket.on(
        'e2e:fail',
        ({ pr }) => {
          this.postComment(pr.number, `E2E tests failed, [click here](http://xcaliber-bot.herokuapp.com/e2e/${pr.number}) to re-run.`);
          this.addLabels(pr, ['e2e:fail']);
        },
      );
      socket.on('e2e:success', ({ pr }) => {
        this.removeLabel(pr, 'e2e:fail');
        this.addLabels(pr, ['e2e:success']);
      });
    });
  }

  runTests(pr) {
    this.getDeployedUrls(pr, deployedUrl => {
      this.getIssues(pr, issues => this.websocket.emit('e2e:run', { issues, pr, deployedUrl }));
    });
  }

  getDeployedUrls(pr, callback) {
    let deployedUrl = {};
    this.getComments(pr.number, comments => {
      let selectedComment = comments.filter(comment => comment.body.indexOf('Deployment link(s):') !== -1 && comment.body.indexOf('Cloned PR(s):') !== -1)[0];
      selectedComment.body
        .split('Deployment link(s):')[1]
        .split('Cloned PR(s):')[0]
        .split('\n')
        .filter(item => item.split(': ').length === 2)
        .map(item => deployedUrl[item.split(': ')[0]] = item.split(': ')[1]);

      callback(deployedUrl);
    });
  }

  checkReviews(pr, callback) {
    this.github.pullRequests.getReviews({
      owner: config.github.repoOwner,
      repo: config.github.repo,
      number: pr.number,
    },
    this.genericAction(
      'getReview: Error while trying to get the reviews: ',
      resp => {
        let approvalMap = {};
        let rejected = 0;
        let approved = 0;

        resp.map(item => approvalMap[item.user.login] = item.state);

        for (var key in approvalMap) {
          switch(approvalMap[key]) {
            case 'APPROVED':
              approved++;
              break;
            case 'CHANGES_REQUESTED':
              rejected++;
              break;
          }
        }

        if (rejected === 0 && approved >= config.github.reviewsNeeded) {
          this.addLabels(pr, [config.github.label.ready], callback);
          this.getDeployedUrls(pr, deployedUrls => {
            this.getIssues(pr, issues => this.websocket.emit('approved', { issues, pr, deployedUrls}));
          });
        }
      }
    ));
  }

  getIssues(pr, callback) {
    this.getCommits(pr, resp => {
      const issues = [];
      resp.forEach(item => {
        const parsedCommit = this.parseCommit(item.commit.message);
        if (parsedCommit.valid && issues.indexOf(parsedCommit.issue) === -1) {
          issues.push(parsedCommit.issue);
        }
      });
      callback(issues);
    });

  }

  /**
   * Extract some data from the commit message.
   *
   * @param {string} commitMessage
   * @returns {object}
   */
  parseCommit(commitMessage) {
    const jiraAndType = commitMessage.match(config.github.commitRegex);

    const commit = {
      issue: '',
      project: '',
      type: '',
      valid: jiraAndType !== null,
    };

    if (jiraAndType) {
      commit.issue = `${jiraAndType[1]}-${jiraAndType[2]}`;
      commit.project = jiraAndType[1];
      commit.type = jiraAndType[3];
    }

    return commit;
  }

  updateLabels(pr, callback) {
    this.getCommits(pr, resp => {
      const labels = [];
      resp.forEach(item => {
        const parsedCommit = this.parseCommit(item.commit.message);
        if (!parsedCommit.valid) {
          return;
        }

        if(labels.indexOf(parsedCommit.project) === -1) {
          labels.push(parsedCommit.project);
        }

        if(labels.indexOf(config.github.typeLabelMap[parsedCommit.type]) === -1) {
          labels.push(config.github.typeLabelMap[parsedCommit.type]);
        }
      });

      this.addLabels(pr, labels, callback);
    });
  }

  setReviewers(pr, callback) {
    const team = config.projects.filter(item => pr.title.indexOf(item) > -1)[0] || config.projects[0];
    const reviewers = config.github.reviewers[team];

    const myIndex = reviewers.indexOf(pr.user.login);
    if (myIndex > -1) {
      reviewers.splice(myIndex, 1);
    }

    this.github.pullRequests.createReviewRequest({
      number: pr.number,
      owner: config.github.repoOwner,
      repo: config.github.repo,
      reviewers,
    }, this.genericAction('createReviewRequest: Error while fetching creating reviewers', callback));
  }
  // Clone
  doForEachClone(callback) {
    config.projects.forEach(project => {
      if (!config.github.clone[project]) {
        return;
      }
      callback(project);
    });
  }
  clonePr (pr, project, callback) {
    this.github.pullRequests.create({
      title: `[clone-${pr.number}] ${pr.title}`,
      body: `Original PR: https://github.com/${config.github.repoOwner}/${config.github.repo}/pull/${pr.number}`,
      head: pr.head.label,
      base: 'master',
      owner: config.github.clone[project].owner,
      repo: config.github.clone[project].repo,
    }, (error, result) => {
      if(error) {
        return console.log('Clone PR error', error);
      }

      callback({
        deploy: this.getLink(config.github.clone[project].herokuApp, result.data.number),
        clone: {
          ...config.github.clone[project],
          number: result.data.number
        },
      });
    });
  }

  closeClone (pr, project, callback) {
    this.github.pullRequests.getAll({
      owner: config.github.clone[project].owner,
      repo: config.github.clone[project].repo,
    },
    this.genericAction(
      'getPullRequests: Error while fetching PRs ',
      clones => {
        let clone = clones.filter(clone => clone.title.indexOf(`[clone-${pr.number}]`) > -1);
        if(clone.length === 0) {
          // this.postComment(pr.number, `Clone for ${project} not found`, callback);
          return;
        }

        this.github.issues.edit({
          owner: config.github.clone[project].owner,
          repo: config.github.clone[project].repo,
          number: clone[0].number,
          state: 'closed',
        }, this.genericAction('issues.edit: Error while closing a cloned pull request', callback));
      }
    ));
  }

  closePr(pr, callback) {
    this.github.issues.edit({
      owner: config.github.repoOwner,
      repo: config.github.repo,
      number: pr,
      state: 'closed',
    }, this.genericAction('issues.edit: Error while closing a cloned pull request', callback));
  }

  addLabels (pr, labels, callback) {
    this.github.issues.addLabels({
      owner: config.github.repoOwner,
      repo: config.github.repo,
      number: pr.number,
      labels
    }, this.genericAction('addLabels: Error while trying add labels', callback));
  }

  removeLabel (pr, label, callback) {
    this.github.issues.removeLabel({
      owner: config.github.repoOwner,
      repo: config.github.repo,
      number: pr.number,
      name: label
    }, this.genericAction('addLabels: Error while trying add labels', callback));
  }

  selfAssignee(pr, callback) {
    this.github.issues.addAssigneesToIssue({
      owner: config.github.repoOwner,
      repo: config.github.repo,
      number: pr.number,
      assignees: [pr.user.login]
    }, this.genericAction('addAssigneesToIssue: Error while assigning', callback));
  }

  postComment(number, comment, callback) {
    this.github.issues.createComment({
      owner: config.github.repoOwner,
      repo: config.github.repo,
      number: number,
      body: comment
    }, this.genericAction('postComment: Error while trying to post instructions', callback));
  }

  getComments(number, callback) {
    this.github.issues.getComments({
      owner: config.github.repoOwner,
      repo: config.github.repo,
      number: number,
    }, this.genericAction('postComment: Error while trying to post instructions', callback));
  }

  getCommits(pr, callback) {
    this.github.pullRequests.getCommits({
      owner: config.github.repoOwner,
      repo: config.github.repo,
      number: pr.number,
    }, this.genericAction('getCommits: Error while trying to get commits', callback));
  }

  getLabels(pr, callback) {
    this.github.issues.getIssueLabels({
      owner: config.github.repoOwner,
      repo: config.github.repo,
      number: pr.number
    }, this.genericAction('getIssueLabels: Error while trying get labels', callback));
  }

  getPullRequests(callback) {
    this.github.pullRequests.getAll({
        owner: config.github.repoOwner,
        repo: config.github.repo,
      }, this.genericAction('getPullRequests: Error while fetching PRs ', callback));
  }

  getPullRequest(number, callback) {
    this.github.pullRequests.get({
        owner: config.github.repoOwner,
        repo: config.github.repo,
        number
    }, this.genericAction('get: Error while fetching PR ', callback));
  }

  getOtherPR(prInfo = {}, callback) {
    this.github.pullRequests.get({
        owner: prInfo.owner || config.github.repoOwner,
        repo: prInfo.repo || config.github.repo,
        number: prInfo.number
    }, this.genericAction('get: Error while fetching PR ', callback));
  }

  genericAction(message, callback) {
    return (error, result) => {
      if (error) {
        return console.log('[error]' + message, error);
      }

      if (callback) {
        callback(result.data);
      }
    }
  }

  getLink(number, app) {
    return `https://${number}-pr-${app}.herokuapp.com/`;
  }
}

module.exports = new Bot();

