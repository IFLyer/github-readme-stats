// @ts-check

import axios from "axios";
import * as dotenv from "dotenv";
import githubUsernameRegex from "github-username-regex";
import { calculateRank } from "../calculateRank.js";
import { retryer } from "../common/retryer.js";
import { logger } from "../common/log.js";
import { excludeRepositories } from "../common/envs.js";
import { CustomError, MissingParamError } from "../common/error.js";
import { request } from "../common/http.js";

dotenv.config();

// Fine-grained personal access tokens cannot access several user-level
// GraphQL connections (contributionsCollection, stargazers, ...), so all
// stats are fetched via the REST API. GraphQL is only used for the fields
// that have no REST equivalent, with a graceful fallback to zero.

const GRAPHQL_STATS_QUERY = `
  query userInfo($login: String!, $includeDiscussions: Boolean!, $includeDiscussionsAnswers: Boolean!) {
    user(login: $login) {
      repositoriesContributedTo(first: 1, contributionTypes: [COMMIT, ISSUE, PULL_REQUEST, REPOSITORY]) {
        totalCount
      }
      repositoryDiscussions @include(if: $includeDiscussions) {
        totalCount
      }
      repositoryDiscussionComments(onlyAnswers: true) @include(if: $includeDiscussionsAnswers) {
        totalCount
      }
    }
  }
`;

/**
 * Optional GraphQL fetcher for fields without a REST equivalent.
 * Errors are tolerated by the caller (fields fall back to zero).
 *
 * @param {any} variables Fetcher variables.
 * @param {string} token GitHub token.
 * @returns {Promise<import('axios').AxiosResponse>} Axios response.
 */
const graphqlFetcher = (variables, token) => {
  return request(
    {
      query: GRAPHQL_STATS_QUERY,
      variables,
    },
    {
      Authorization: `bearer ${token}`,
    },
  );
};

/**
 * Send a GET request to the GitHub REST API.
 *
 * @param {string} url Request URL.
 * @param {string} token GitHub token.
 * @returns {Promise<import('axios').AxiosResponse>} Axios response.
 */
const restGet = (url, token) => {
  return axios({
    method: "get",
    url,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/vnd.github+json",
      Authorization: `token ${token}`,
    },
  });
};

const fetchUserInfo = (variables, token) =>
  restGet(`https://api.github.com/users/${variables.login}`, token);

const fetchTokenOwner = (_variables, token) =>
  restGet("https://api.github.com/user", token);

const fetchReposPage = (variables, token) =>
  restGet(
    variables.selfRepos
      ? `https://api.github.com/user/repos?affiliation=owner&per_page=100&page=${variables.page}`
      : `https://api.github.com/users/${variables.login}/repos?type=owner&per_page=100&page=${variables.page}`,
    token,
  );

const fetchSearchCount = (variables, token) =>
  restGet(
    `https://api.github.com/search/${variables.endpoint}?q=${variables.query}&per_page=1`,
    token,
  );

/**
 * Run a REST search query and return its total_count.
 *
 * @param {string} query Search query (already `+` separated).
 * @param {string} endpoint Search endpoint: "issues" or "commits".
 * @param {string} label Human readable label for error messages.
 * @returns {Promise<number>} Result count.
 */
const searchTotal = async (query, endpoint, label) => {
  const res = await retryer(fetchSearchCount, { query, endpoint });
  const total = res.data.total_count;
  if (isNaN(total)) {
    throw new CustomError(
      `Could not fetch ${label}.`,
      CustomError.GITHUB_REST_API_ERROR,
    );
  }
  return total || 0;
};

/**
 * Fetch stats for a given username.
 *
 * @param {string} username GitHub username.
 * @param {boolean} _includeAllCommits Kept for API compatibility; commits are
 * always counted across all time via the REST search API.
 * @param {string[]} exclude_repo Repositories to exclude.
 * @param {boolean} include_merged_pull_requests Include merged pull requests.
 * @param {boolean} include_discussions Include discussions.
 * @param {boolean} include_discussions_answers Include discussions answers.
 * @param {number|undefined} commits_year Year to count total commits.
 * @returns {Promise<import("./types").StatsData>} Stats data.
 */
const fetchStats = async (
  username,
  _includeAllCommits = false,
  exclude_repo = [],
  include_merged_pull_requests = false,
  include_discussions = false,
  include_discussions_answers = false,
  commits_year,
) => {
  if (!username) {
    throw new MissingParamError(["username"]);
  }

  if (!githubUsernameRegex.test(username)) {
    logger.log("Invalid username provided.");
    throw new CustomError(
      "Invalid username provided.",
      CustomError.GITHUB_REST_API_ERROR,
    );
  }

  const stats = {
    name: "",
    totalPRs: 0,
    totalPRsMerged: 0,
    mergedPRsPercentage: 0,
    totalReviews: 0,
    totalCommits: 0,
    totalIssues: 0,
    totalStars: 0,
    totalDiscussionsStarted: 0,
    totalDiscussionsAnswered: 0,
    contributedTo: 0,
    rank: { level: "C", percentile: 100 },
  };

  const dateFilter = commits_year
    ? `+committer-date:${commits_year}-01-01..${commits_year}-12-31`
    : "";

  // Fetch everything independent in parallel.
  const [
    userInfoRes,
    tokenOwnerRes,
    totalCommits,
    totalPRs,
    totalPRsMerged,
    totalIssues,
    totalReviews,
  ] = await Promise.all([
    retryer(fetchUserInfo, { login: username }),
    retryer(fetchTokenOwner, {}),
    searchTotal(`author:${username}${dateFilter}`, "commits", "total commits"),
    searchTotal(`type:pr+author:${username}`, "issues", "total pull requests"),
    include_merged_pull_requests
      ? searchTotal(
          `type:pr+author:${username}+is:merged`,
          "issues",
          "merged pull requests",
        )
      : Promise.resolve(0),
    searchTotal(`type:issue+author:${username}`, "issues", "total issues"),
    searchTotal(`type:pr+reviewed-by:${username}`, "issues", "total reviews"),
  ]);

  stats.name = userInfoRes.data.name || username;
  stats.totalCommits = totalCommits;
  stats.totalPRs = totalPRs;
  stats.totalPRsMerged = totalPRsMerged;
  stats.mergedPRsPercentage =
    include_merged_pull_requests && totalPRs
      ? (totalPRsMerged / totalPRs) * 100
      : 0;
  stats.totalIssues = totalIssues;
  stats.totalReviews = totalReviews;

  // Repositories: when the requested user owns the PAT, /user/repos also
  // returns private repositories (the reason this instance is self-hosted).
  const selfRepos =
    tokenOwnerRes.data?.login?.toLowerCase() === username.toLowerCase();
  const allExcludedRepos = [...exclude_repo, ...excludeRepositories];
  const repoToHide = new Set(allExcludedRepos);

  let repos = [];
  let page = 1;
  for (;;) {
    const res = await retryer(fetchReposPage, {
      login: username,
      selfRepos,
      page,
    });
    repos.push(...res.data);
    if (res.data.length < 100) break;
    page++;
  }

  stats.totalStars = repos
    .filter((repo) => !repoToHide.has(repo.name))
    .reduce((total, repo) => total + repo.stargazers_count, 0);

  // Optional GraphQL fields — gracefully degrade to zero when the token
  // type cannot access them.
  try {
    const res = await retryer(graphqlFetcher, {
      login: username,
      includeDiscussions: include_discussions,
      includeDiscussionsAnswers: include_discussions_answers,
    });
    if (res.data.errors) {
      logger.error(res.data.errors);
    } else {
      const user = res.data.data.user;
      stats.contributedTo = user.repositoriesContributedTo.totalCount;
      if (include_discussions) {
        stats.totalDiscussionsStarted = user.repositoryDiscussions.totalCount;
      }
      if (include_discussions_answers) {
        stats.totalDiscussionsAnswered =
          user.repositoryDiscussionComments.totalCount;
      }
    }
  } catch (err) {
    logger.error(err);
  }

  stats.rank = calculateRank({
    all_commits: true,
    commits: stats.totalCommits,
    prs: stats.totalPRs,
    reviews: stats.totalReviews,
    issues: stats.totalIssues,
    repos: repos.length,
    stars: stats.totalStars,
    followers: userInfoRes.data.followers,
  });

  return stats;
};

export { fetchStats };
export default fetchStats;
