import { mutationExecute } from "../../../tools/_shared/mutation-tool.js";
import { sendMessageMutation } from "../../../tools/messaging/send-message.mutation.js";

export default {
  execute: mutationExecute(sendMessageMutation),
};
