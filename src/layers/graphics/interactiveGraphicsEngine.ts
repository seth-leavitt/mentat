import {
  GraphicsStyleProfile,
  InteractiveComponent,
  InteractiveVisualizationProposal
} from "../../domain/models.js";
import { createId } from "../../utils/text.js";

const STYLE_PROFILE: GraphicsStyleProfile = {
  palette: {
    primary: "#0D3B66",
    secondary: "#3A86FF",
    accent: "#FF9F1C",
    surface: "#F8F4E3",
    ink: "#1F2933"
  },
  typography: {
    heading: "Source Serif 4",
    body: "Work Sans",
    mono: "IBM Plex Mono"
  },
  motionPreset: "guided_focus"
};

export class InteractiveGraphicsEngine {
  createComponent(proposal: InteractiveVisualizationProposal): InteractiveComponent {
    return {
      id: createId("component", proposal.id),
      template: proposal.template,
      title: `${proposal.concept} interactive`,
      payload: this.buildPayload(proposal),
      styleProfile: STYLE_PROFILE
    };
  }

  private buildPayload(proposal: InteractiveVisualizationProposal): Record<string, unknown> {
    switch (proposal.template) {
      case "concept_map":
        return {
          center: proposal.concept,
          branches: [
            `${proposal.concept} foundations`,
            `${proposal.concept} application`,
            `${proposal.concept} pitfalls`
          ]
        };
      case "timeline":
        return {
          events: [
            { label: "Origin", note: `Initial context for ${proposal.concept}` },
            { label: "Development", note: `Core evolution of ${proposal.concept}` },
            { label: "Modern usage", note: `Current practical use of ${proposal.concept}` }
          ]
        };
      case "formula_simulator":
        return {
          variables: ["x", "y", "z"],
          expression: `${proposal.concept} = f(x, y, z)`,
          controls: ["slider:x", "slider:y", "slider:z"]
        };
      case "comparison_matrix":
        return {
          axisX: ["Option A", "Option B", "Option C"],
          axisY: ["Benefit", "Risk", "Cost"],
          target: proposal.concept
        };
      default:
        return { concept: proposal.concept };
    }
  }
}
