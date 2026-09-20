# Print the container setup script for a dry run inside a throwaway container.
import sys

sys.path.insert(0, r"D:\code\dsh-jev\tmp\pier-pilot")
import pilot_setup  # noqa: E402

print(pilot_setup.wrapped_setup(pilot_setup.PROFILE_TREATMENT, True))
