import assert from "node:assert/strict";
import test from "node:test";
import { prisma } from "../database/prisma.js";
import {
  ConversationError,
  createConversation,
  deleteConversation,
  getConversation,
  listConversations,
  updateConversation,
  sendConversationMessage,
} from "../services/conversationFlow.js";

test("conversation flow isolates users and branches and cascades deletes", async () => {
  const suffix = `${Date.now()}-${Math.random()}`;
  const firstUser = await prisma.user.create({
    data: { email: `conversation-${suffix}-a@example.com`, passwordHash: "test" },
  });
  const secondUser = await prisma.user.create({
    data: { email: `conversation-${suffix}-b@example.com`, passwordHash: "test" },
  });
  const repository = await prisma.repository.create({
    data: {
      githubRepoId: BigInt(`${Date.now()}${Math.floor(Math.random() * 1000)}`),
      owner: "test-owner",
      name: "conversation-test",
      htmlUrl: "https://github.com/test-owner/conversation-test",
      defaultBranch: "main",
    },
  });
  const branch = await prisma.branchIndex.create({
    data: { repositoryId: repository.id, branchName: "main", status: "ready" },
  });
  await prisma.userBranchAccess.createMany({
    data: [
      { userId: firstUser.id, branchIndexId: branch.id },
      { userId: secondUser.id, branchIndexId: branch.id },
    ],
  });

  try {
    const first = await createConversation(firstUser.id, branch.id);
    const second = await createConversation(firstUser.id, branch.id);
    assert.equal((await listConversations(firstUser.id, branch.id)).length, 2);

    await updateConversation(firstUser.id, first.id, "Renamed");
    assert.equal((await getConversation(firstUser.id, first.id)).title, "Renamed");
    await assert.rejects(
      getConversation(secondUser.id, first.id),
      (error) => error instanceof ConversationError && error.statusCode === 404,
    );

    await prisma.message.create({
      data: {
        conversationId: first.id,
        role: "assistant",
        content: "answer",
        citations: {
          create: {
            filePath: "src/index.ts",
            startLine: 1,
            endLine: 3,
            commitSha: "0123456789abcdef0123456789abcdef01234567",
          },
        },
      },
    });
    const withCitation = await getConversation(firstUser.id, first.id);
    assert.equal(withCitation.messages[0].citations[0].filePath, "src/index.ts");

    await deleteConversation(firstUser.id, first.id);
    assert.equal(await prisma.message.count({ where: { conversationId: first.id } }), 0);
    assert.equal(await prisma.conversation.count({ where: { id: second.id } }), 1);
  } finally {
    await prisma.repository.delete({ where: { id: repository.id } });
    await prisma.user.deleteMany({
      where: { id: { in: [firstUser.id, secondUser.id] } },
    });
  }
});

test("completed client IDs return the persisted assistant response consistently", async () => {
  const suffix = `${Date.now()}-${Math.random()}`;
  const user = await prisma.user.create({
    data: { email: `idempotency-${suffix}@example.com`, passwordHash: "test" },
  });
  const repository = await prisma.repository.create({
    data: {
      githubRepoId: BigInt(`${Date.now()}${Math.floor(Math.random() * 1000)}`),
      owner: "test-owner",
      name: "idempotency-test",
      htmlUrl: "https://github.com/test-owner/idempotency-test",
      defaultBranch: "main",
    },
  });
  const branch = await prisma.branchIndex.create({
    data: { repositoryId: repository.id, branchName: "main", status: "ready" },
  });
  await prisma.userBranchAccess.create({
    data: { userId: user.id, branchIndexId: branch.id },
  });

  try {
    const conversation = await createConversation(user.id, branch.id);
    const clientId = crypto.randomUUID();
    const userMessage = await prisma.message.create({
      data: {
        conversationId: conversation.id,
        role: "user",
        content: "repeat safely",
        clientId,
        status: "completed",
      },
    });
    const assistant = await prisma.message.create({
      data: {
        conversationId: conversation.id,
        role: "assistant",
        content: "persisted answer",
      },
    });

    const first = await sendConversationMessage(
      user.id,
      conversation.id,
      "repeat safely",
      clientId,
    );
    const second = await sendConversationMessage(
      user.id,
      conversation.id,
      "repeat safely",
      clientId,
    );
    assert.equal(first.assistant.id, assistant.id);
    assert.deepEqual(first, second);
    assert.equal(
      await prisma.message.count({
        where: { conversationId: conversation.id, clientId },
      }),
      1,
    );
    assert.ok(userMessage.id);
  } finally {
    await prisma.repository.delete({ where: { id: repository.id } });
    await prisma.user.delete({ where: { id: user.id } });
  }
});
