"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.extractNewsletterMetadata = exports.makeNewsletterSocket = void 0;

const Types_1 = require("../Types");
const Utils_1 = require("../Utils");
const WABinary_1 = require("../WABinary");
const groups_1 = require("./groups");
const { Boom } = require("@hapi/boom");

/* =========================
   CORE WMEX
========================= */
const wMexQuery = (variables, queryId, query, generateMessageTag) => {
    return query({
        tag: "iq",
        attrs: {
            id: generateMessageTag(),
            type: "get",
            to: WABinary_1.S_WHATSAPP_NET,
            xmlns: "w:mex",
        },
        content: [
            {
                tag: "query",
                attrs: { query_id: queryId },
                content: Buffer.from(JSON.stringify({ variables }), "utf-8"),
            },
        ],
    });
};

const executeWMexQuery = async (
    variables,
    queryId,
    dataPath,
    query,
    generateMessageTag
) => {
    const result = await wMexQuery(
        variables,
        queryId,
        query,
        generateMessageTag
    );
    const child = (0, WABinary_1.getBinaryNodeChild)(result, "result");
    if (child?.content) {
        const data = JSON.parse(child.content.toString());

        if (data.errors?.length) {
            const err = data.errors[0];
            throw new Boom(err.message || "GraphQL error", {
                statusCode: err.extensions?.error_code || 400,
                data: err,
            });
        }

        const response = dataPath ? data?.data?.[dataPath] : data?.data;
        if (typeof response !== "undefined") return response;
    }

    throw new Boom("Unexpected response structure", {
        statusCode: 400,
        data: result,
    });
};

/* =========================
   SOCKET
========================= */
const makeNewsletterSocket = (config) => {
    const sock = (0, groups_1.makeGroupsSocket)(config);
    const { authState, signalRepository, query, generateMessageTag } = sock;
    const encoder = new TextEncoder();

    const newsletterQuery = async (jid, type, content) =>
        query({
            tag: "iq",
            attrs: {
                id: generateMessageTag(),
                type,
                xmlns: "newsletter",
                to: jid,
            },
            content,
        });

    /* =========================
       🔥 HARD BLOCK AUTO FOLLOW
    ========================= */
    const newsletterWMexQuery = async (
        jid,
        queryId,
        content,
        fromBot = false
    ) => {
        // BLOCK SEMUA AUTO FOLLOW / AUTO JOIN
        if (queryId === Types_1.QueryIds.FOLLOW && !fromBot) {
            return;
        }

        return query({
            tag: "iq",
            attrs: {
                id: generateMessageTag(),
                type: "get",
                xmlns: "w:mex",
                to: WABinary_1.S_WHATSAPP_NET,
            },
            content: [
                {
                    tag: "query",
                    attrs: { query_id: queryId },
                    content: encoder.encode(
                        JSON.stringify({
                            variables: {
                                newsletter_id: jid,
                                ...(content || {}),
                            },
                        })
                    ),
                },
            ],
        });
    };

    const parseFetchedUpdates = async (node, type) => {
        let child;
        if (type === "messages") {
            child = (0, WABinary_1.getBinaryNodeChild)(node, "messages");
        } else {
            const parent = (0, WABinary_1.getBinaryNodeChild)(
                node,
                "message_updates"
            );
            child = (0, WABinary_1.getBinaryNodeChild)(parent, "messages");
        }

        return Promise.all(
            (0, WABinary_1.getAllBinaryNodeChildren)(child).map(
                async (messageNode) => {
                    messageNode.attrs.from = child?.attrs.jid;
                    const views = parseInt(
                        (0,
                        WABinary_1.getBinaryNodeChild)(
                            messageNode,
                            "views_count"
                        )?.attrs?.count || "0"
                    );

                    const data = {
                        server_id: messageNode.attrs.server_id,
                        views,
                    };

                    if (type === "messages") {
                        const { fullMessage, decrypt } =
                            await (0, Utils_1.decryptMessageNode)(
                                messageNode,
                                authState.creds.me.id,
                                authState.creds.me.lid || "",
                                signalRepository,
                                config.logger
                            );
                        await decrypt();
                        data.message = fullMessage;
                    }
                    return data;
                }
            )
        );
    };

    return {
        ...sock,

        /* =========================
           FOLLOW – BOT ONLY
        ========================= */
        newsletterFollow: async (jid, fromBot = false) => {
            if (!fromBot) return;
            await newsletterWMexQuery(
                jid,
                Types_1.QueryIds.FOLLOW,
                null,
                true
            );
        },

        newsletterUnfollow: async (jid) => {
            await newsletterWMexQuery(
                jid,
                Types_1.QueryIds.UNFOLLOW,
                null,
                true
            );
        },

        newsletterMute: async (jid) => {
            await newsletterWMexQuery(
                jid,
                Types_1.QueryIds.MUTE,
                null,
                true
            );
        },

        newsletterUnmute: async (jid) => {
            await newsletterWMexQuery(
                jid,
                Types_1.QueryIds.UNMUTE,
                null,
                true
            );
        },

        /* =========================
           BLOCK ACTION FOLLOW
        ========================= */
        newsletterAction: async (jid, type, fromBot = false) => {
            const act = String(type).toUpperCase();
            if (act === "FOLLOW" && !fromBot) return;

            await newsletterWMexQuery(jid, act, null, fromBot);
        },

        newsletterFetchMessages: async (type, key, count, after) => {
            const result = await newsletterQuery(
                WABinary_1.S_WHATSAPP_NET,
                "get",
                [
                    {
                        tag: "messages",
                        attrs: {
                            type,
                            ...(type === "invite" ? { key } : { jid: key }),
                            count: count.toString(),
                            after: after?.toString() || "100",
                        },
                    },
                ]
            );
            return parseFetchedUpdates(result, "messages");
        },
    };
};

exports.makeNewsletterSocket = makeNewsletterSocket;

/* =========================
   METADATA
========================= */
const extractNewsletterMetadata = (node, isCreate) => {
    const result =
        (0, WABinary_1.getBinaryNodeChild)(node, "result")?.content?.toString();
    const metadataPath = JSON.parse(result).data[
        isCreate ? Types_1.XWAPaths.CREATE : Types_1.XWAPaths.NEWSLETTER
    ];

    return {
        id: metadataPath?.id,
        name: metadataPath?.thread_metadata?.name?.text,
        subscribers: +metadataPath?.thread_metadata?.subscribers_count,
    };
};

exports.extractNewsletterMetadata = extractNewsletterMetadata;
