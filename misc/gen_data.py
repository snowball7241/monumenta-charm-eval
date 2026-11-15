import json 
from urllib.request import urlopen
import re

# a charm set holds at most this many charms
CHARM_COUNT_MAX = 7
# The API reports effectCap 0 for effects that have no cap in game (e.g. Steel Stallion Health, Volley Arrows). mtce scores
# every effect relative to a scale, normally its cap; an uncapped effect is scaled to this many times its highest rarity
# value instead, which no set can reach, so it is never treated as maxed.
UNCAPPED_SCALE_FACTOR = 10

def gen(j: list[dict]):
    ids = []
    caps = []
    names = []
    isPercents = []
    rarityValues = []
    scales = []

    for ent in j:
        name = str(ent["effectName"])
        id = name.lower().replace(" ", "_")
        cap = float(ent["effectCap"])
        if cap != 0:
            scale = cap
        else:
            top = float(ent["rarityValues"][-1])
            scale = UNCAPPED_SCALE_FACTOR * top
            # even a set of perfect top-rarity rolls must stay below the scale, or it would be clamped like a cap
            assert top != 0 and CHARM_COUNT_MAX * (abs(top) + float(ent["variance"])) < abs(scale), name
        isPercent = bool(ent["isPercent"])

        ids.append(id)
        scales.append(scale)
        caps.append(cap)
        names.append(name)
        isPercents.append(isPercent)
        rarityValues.append(ent["rarityValues"][0] >= 5)

    print(f"""
    #pragma once 
    #include <array>
    #include <cstddef>
    #include <cstdint>
    #include <string_view>
    namespace mtce
    {{
        enum class charm_effects : std::uint16_t {{ {",\n".join([re.sub('[^0-9a-zA-Z_]+', '', i).upper() for i in ids])}, ABILITY_COUNT }};

        inline static constexpr std::size_t ABILITY_COUNT = static_cast<std::size_t>(charm_effects::ABILITY_COUNT);

        // 0 means the effect has no cap
        inline static constexpr std::array<double, ABILITY_COUNT> EFFECT_CAPS = {{ {",".join([str(i) for i in caps])} }};

        // what stats are measured against: the cap, or for an uncapped effect a value no charm set can reach
        inline static constexpr std::array<double, ABILITY_COUNT> EFFECT_SCALES = {{ {",".join([str(i) for i in scales])} }};

        inline static constexpr std::array<std::string_view, ABILITY_COUNT> EFFECT_NAMES = {{ {"\n".join([f'"{i}",' for i in ids])} }};
        
        inline static constexpr std::array<std::string_view, ABILITY_COUNT> EFFECT_DISPLAY_NAMES = {{ {"\n".join([f'"{i}",' for i in names])} }};
        
        inline static constexpr std::array<bool, ABILITY_COUNT> EFFECT_IS_PERCENT = {{ {"\n".join([f'{"true" if i else "false"},' for i in isPercents])} }};

        inline static constexpr std::array<bool, ABILITY_COUNT> EFFECT_ROUND_TO_INTEGER = {{ {"\n".join([f'{"true" if i else "false"},' for i in rarityValues])} }};
    }}
    """)


if __name__ == "__main__":
    with urlopen("http://api.playmonumenta.com/zenith_charm_effects") as f:    
        gen(json.load(f))
