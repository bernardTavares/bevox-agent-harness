import { mutationExecute } from "../../../tools/_shared/mutation-tool.js";
import { waitlistAddMutation } from "../../../tools/calendar/waitlist-add.mutation.js";

export default {
  execute: mutationExecute(waitlistAddMutation),
};
