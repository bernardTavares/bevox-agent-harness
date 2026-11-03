import { mutationExecute } from "../../../tools/_shared/mutation-tool.js";
import { createAppointmentMutation } from "../../../tools/calendar/create-appointment.mutation.js";

export default {
  execute: mutationExecute(createAppointmentMutation),
};
