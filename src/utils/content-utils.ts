import { type CollectionEntry, getCollection } from "astro:content";
import I18nKey from "@i18n/i18nKey";
import { i18n } from "@i18n/translation";
import { getCategoryUrl } from "@utils/url-utils.ts";

type PostFilterOptions = {
	includeUnlisted?: boolean;
};

function shouldIncludePost(
	data: CollectionEntry<"posts">["data"],
	options: PostFilterOptions = {},
) {
	if (!import.meta.env.PROD) return true;
	if (data.draft === true) return false;
	if (options.includeUnlisted) return true;
	return data.unlisted !== true;
}

// // Retrieve posts and sort them by publication date
async function getRawSortedPosts(options: PostFilterOptions = {}) {
	const allBlogPosts = await getCollection("posts", ({ data }) => {
		return shouldIncludePost(data, options);
	});

	const sorted = allBlogPosts.sort((a, b) => {
		const dateA = new Date(a.data.published);
		const dateB = new Date(b.data.published);
		return dateA > dateB ? -1 : 1;
	});
	return sorted;
}

function applyAdjacentLinks(
	sorted: CollectionEntry<"posts">[],
	adjacentBySlug: Map<
		string,
		{ nextSlug: string; nextTitle: string; prevSlug: string; prevTitle: string }
	>,
) {
	for (const entry of sorted) {
		const adjacent = adjacentBySlug.get(entry.slug);
		entry.data.nextSlug = adjacent?.nextSlug ?? "";
		entry.data.nextTitle = adjacent?.nextTitle ?? "";
		entry.data.prevSlug = adjacent?.prevSlug ?? "";
		entry.data.prevTitle = adjacent?.prevTitle ?? "";
	}
}

function buildAdjacentMap(sorted: CollectionEntry<"posts">[]) {
	const adjacentBySlug = new Map<
		string,
		{ nextSlug: string; nextTitle: string; prevSlug: string; prevTitle: string }
	>();

	for (let i = 1; i < sorted.length; i++) {
		adjacentBySlug.set(sorted[i].slug, {
			nextSlug: sorted[i - 1].slug,
			nextTitle: sorted[i - 1].data.title,
			prevSlug: "",
			prevTitle: "",
		});
	}
	for (let i = 0; i < sorted.length - 1; i++) {
		const existing = adjacentBySlug.get(sorted[i].slug) ?? {
			nextSlug: "",
			nextTitle: "",
			prevSlug: "",
			prevTitle: "",
		};
		adjacentBySlug.set(sorted[i].slug, {
			...existing,
			prevSlug: sorted[i + 1].slug,
			prevTitle: sorted[i + 1].data.title,
		});
	}

	return adjacentBySlug;
}

export async function getSortedPosts() {
	const sorted = await getRawSortedPosts();

	const adjacentBySlug = buildAdjacentMap(sorted);
	applyAdjacentLinks(sorted, adjacentBySlug);

	return sorted;
}
export async function getSortedPostsForPaths() {
	const allSorted = await getRawSortedPosts({ includeUnlisted: true });
	const publicSorted = await getRawSortedPosts();
	const adjacentBySlug = buildAdjacentMap(publicSorted);

	applyAdjacentLinks(allSorted, adjacentBySlug);
	return allSorted;
}
export type PostForList = {
	slug: string;
	data: CollectionEntry<"posts">["data"];
};
export async function getSortedPostsList(): Promise<PostForList[]> {
	const sortedFullPosts = await getRawSortedPosts();

	// delete post.body
	const sortedPostsList = sortedFullPosts.map((post) => ({
		slug: post.slug,
		data: post.data,
	}));

	return sortedPostsList;
}
export type Tag = {
	name: string;
	count: number;
};

export async function getTagList(): Promise<Tag[]> {
	const allBlogPosts = await getCollection<"posts">("posts", ({ data }) => {
		return shouldIncludePost(data);
	});

	const countMap: { [key: string]: number } = {};
	allBlogPosts.forEach((post: { data: { tags: string[] } }) => {
		post.data.tags.forEach((tag: string) => {
			if (!countMap[tag]) countMap[tag] = 0;
			countMap[tag]++;
		});
	});

	// sort tags
	const keys: string[] = Object.keys(countMap).sort((a, b) => {
		return a.toLowerCase().localeCompare(b.toLowerCase());
	});

	return keys.map((key) => ({ name: key, count: countMap[key] }));
}

export type Category = {
	name: string;
	count: number;
	url: string;
};

export async function getCategoryList(): Promise<Category[]> {
	const allBlogPosts = await getCollection<"posts">("posts", ({ data }) => {
		return shouldIncludePost(data);
	});
	const count: { [key: string]: number } = {};
	allBlogPosts.forEach((post: { data: { category: string | null } }) => {
		if (!post.data.category) {
			const ucKey = i18n(I18nKey.uncategorized);
			count[ucKey] = count[ucKey] ? count[ucKey] + 1 : 1;
			return;
		}

		const categoryName =
			typeof post.data.category === "string"
				? post.data.category.trim()
				: String(post.data.category).trim();

		count[categoryName] = count[categoryName] ? count[categoryName] + 1 : 1;
	});

	const lst = Object.keys(count).sort((a, b) => {
		return a.toLowerCase().localeCompare(b.toLowerCase());
	});

	const ret: Category[] = [];
	for (const c of lst) {
		ret.push({
			name: c,
			count: count[c],
			url: getCategoryUrl(c),
		});
	}
	return ret;
}
