import { fetchUrl } from "./fetch";
import { searchWeb } from "./search";

export { fetchUrl, searchWeb };

export function fetchReddit(subreddit: string): Promise<string> {
  return fetchUrl(`https://old.reddit.com/r/${encodeURIComponent(subreddit)}/`);
}

export function fetchGitHubRepo(owner: string, repo: string): Promise<string> {
  return fetchUrl(`https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`);
}

export function fetchArxiv(absId: string): Promise<string> {
  return fetchUrl(`https://arxiv.org/abs/${encodeURIComponent(absId)}`);
}

export function fetchWikipedia(topic: string): Promise<string> {
  return fetchUrl(`https://en.wikipedia.org/wiki/${encodeURIComponent(topic)}`);
}
