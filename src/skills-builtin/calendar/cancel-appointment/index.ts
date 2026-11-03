import { mutationExecute } from "../../../tools/_shared/mutation-tool.js";
import { cancelAppointmentMutation } from "../../../tools/calendar/cancel-appointment.mutation.js";

export default {
  execute: mutationExecute(cancelAppointmentMutation),
};
